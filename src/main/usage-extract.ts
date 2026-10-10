// One pi session file to FileUsageFacts: streams bytes and parses only the records that can change the facts.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { AssistantMessage, SessionEntry, SessionHeader, ToolResultMessage } from "../shared/protocol";
import {
  ACTIVE_GAP_CAP_MS,
  CACHE_MISS_MIN_INPUT,
  CONTEXT_EDGES,
  CONTEXT_TIER_EDGE,
  type ErrorCategory,
  type FileUsageFacts,
  type PendingCall,
  type PromptStats,
  STEP_EDGES,
  STOP_REASONS,
  type SourceRoot,
  type StopReason,
  type TokenCounts,
  type ToolStat,
  type UsageBucket,
  type UsageResume,
  USAGE_FACTS_VERSION,
} from "../shared/usage";
import { classifySession, namesPignaTools, startsAtpRuntime } from "../shared/usage-classify";

export interface ExtractTarget {
  root: SourceRoot;
  path: string;
}

type FileRecord = SessionHeader | SessionEntry;
type TurnMessage = AssistantMessage & { thinkingLevel?: string };
type ToolResultRecord = ToolResultMessage & { nestedCalls?: { calls?: unknown[] } };

const LF = 0x0a;
const CR = 0x0d;
const READ_CHUNK = 1024 * 1024;
const HEAD_BYTES = 512;
const HOUR_MS = 3_600_000;

const KNOWN_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "custom_message",
  "session_info",
  "custom",
  "label",
  "usage",
  "context_edit",
]);

const TYPE_PREFIX = /^\{"type":"([^"]*)"/;
const ENTRY_TIMESTAMP = /"timestamp":"([^"]*)"/;

/** Only these message roles change the facts; the others (system, bashExecution, custom, branchSummary) are skipped unparsed. */
function hasRelevantRole(line: Buffer): boolean {
  return line.includes('"role":"user"') || line.includes('"role":"assistant"') || line.includes('"role":"toolResult"');
}

/** The first text of a message's content: where the ATP runner's claim packet begins. */
function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  const block = Array.isArray(content) ? content.find((part) => part?.type === "text" && typeof part.text === "string") : undefined;
  return typeof block?.text === "string" ? block.text : "";
}

const ERROR_RULES: [RegExp, ErrorCategory][] = [
  [/abort/i, "aborted"],
  [/rate limit/i, "rate-limit"],
  [/overloaded|Service Unavailable/i, "overloaded"],
  [/context window/i, "context-overflow"],
  [/signal|process terminated/i, "process"],
  [/WebSocket|timed out|timeout|fetch failed/i, "network"],
];

export async function extractFileUsage(target: ExtractTarget, previous?: FileUsageFacts): Promise<FileUsageFacts | undefined> {
  const info = await stat(target.path);
  // Surface is decided from the first prompt, so a file without one is read in full.
  const resumable =
    previous !== undefined &&
    previous.version === USAGE_FACTS_VERSION &&
    previous.prompts.count > 0 &&
    info.size >= previous.consumedBytes;
  const extraction = new Extraction(resumable ? structuredClone(previous) : emptyFacts(target));
  const scan = await scanLines(target.path, resumable ? previous.consumedBytes : 0, (line) => extraction.ingest(line));
  let consumedBytes = scan.end;
  if (scan.tail && extraction.ingestTail(scan.tail)) consumedBytes += scan.tail.length;
  return extraction.finish({ size: info.size, mtimeMs: info.mtimeMs, consumedBytes });
}

interface Scan {
  /** Absolute offset just past the last LF-terminated line. */
  end: number;
  /** Bytes after that LF: a record still being written, or the file's unterminated last line. */
  tail?: Buffer;
}

async function scanLines(path: string, start: number, visit: (line: Buffer) => void): Promise<Scan> {
  const stream = createReadStream(path, { start, highWaterMark: READ_CHUNK });
  let end = start;
  let carry: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    let lf = chunk.indexOf(LF, from);
    while (lf !== -1) {
      const piece = chunk.subarray(from, lf);
      const line = carry.length > 0 ? Buffer.concat([...carry, piece]) : piece;
      carry = [];
      visit(line);
      end += line.length + 1;
      from = lf + 1;
      lf = chunk.indexOf(LF, from);
    }
    if (from < chunk.length) carry.push(chunk.subarray(from));
  }
  return { end, tail: carry.length > 0 ? Buffer.concat(carry) : undefined };
}

function lineEnd(line: Buffer): number {
  return line.length > 0 && line[line.length - 1] === CR ? line.length - 1 : line.length;
}

function isBlank(line: Buffer, end: number): boolean {
  for (let i = 0; i < end; i++) {
    const byte = line[i];
    if (byte !== 0x20 && byte !== 0x09 && byte !== CR) return false;
  }
  return true;
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): FileRecord | undefined {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
    ? (value as FileRecord)
    : undefined;
}

class Extraction {
  private readonly buckets: Map<string, UsageBucket>;

  constructor(private readonly facts: FileUsageFacts) {
    this.buckets = new Map(facts.buckets.map((bucket) => [bucketKey(bucket.hour, bucket.provider, bucket.model), bucket]));
  }

  ingest(line: Buffer): void {
    const end = lineEnd(line);
    if (isBlank(line, end)) return;
    const head = line.toString("utf8", 0, Math.min(end, HEAD_BYTES));
    if (head.includes('"message":{"role":"system"')) this.systemMessage(line);
    if (TYPE_PREFIX.exec(head)?.[1] === "message" && !hasRelevantRole(line)) {
      const at = headTimestamp(head);
      if (at !== undefined) {
        this.tick(at);
        return;
      }
    }
    const parsed = parseJson(line.toString("utf8", 0, end));
    if (parsed) this.ingestRecord(parsed.value);
    else this.facts.skipped.lines++;
  }

  /** The unterminated last line counts only once it parses: a record pi is still writing stays unread. */
  ingestTail(tail: Buffer): boolean {
    const end = lineEnd(tail);
    if (isBlank(tail, end)) return true;
    const parsed = parseJson(tail.toString("utf8", 0, end));
    if (!parsed) return false;
    this.ingestRecord(parsed.value);
    return true;
  }

  finish(source: { size: number; mtimeMs: number; consumedBytes: number }): FileUsageFacts | undefined {
    const { facts } = this;
    if (!facts.session.id) return undefined;
    facts.buckets = [...this.buckets.values()].sort(compareBuckets);
    facts.prompts = promptView(facts.resume);
    facts.version = USAGE_FACTS_VERSION;
    facts.size = source.size;
    facts.mtimeMs = source.mtimeMs;
    facts.consumedBytes = source.consumedBytes;
    const placed = classifySession({ root: facts.session.root, path: facts.session.path, cwd: facts.session.cwd, parentId: facts.session.parentId, markers: facts.markers });
    Object.assign(facts.session, { project: placed.project, surface: placed.surface, pigna: placed.isPigna, card: placed.card });
    return facts;
  }

  private ingestRecord(value: unknown): void {
    const record = asRecord(value);
    if (!record) {
      this.facts.skipped.lines++;
      return;
    }
    if (record.type === "session") {
      this.header(record);
      return;
    }
    if (!KNOWN_TYPES.has(record.type)) {
      this.facts.skipped.entries++;
      return;
    }
    const entry = record as SessionEntry;
    const at = Date.parse(entry.timestamp);
    if (entry.type === "message" && entry.message?.role === "user") {
      if (this.facts.resume.open === undefined && this.facts.resume.closed.count === 0) {
        this.facts.markers.atpRuntime = startsAtpRuntime(firstText(entry.message.content));
      }
      this.closePrompt();
      this.tick(at);
      this.openPrompt();
      return;
    }
    this.tick(at);
    switch (entry.type) {
      case "message":
        if (entry.message?.role === "assistant") this.turn(entry.message as TurnMessage, at);
        else if (entry.message?.role === "toolResult") this.toolResult(entry.message as ToolResultRecord);
        return;
      case "compaction":
        this.facts.compactions++;
        this.facts.compactedTokens += num(entry.tokensBefore);
        return;
      case "context_edit":
        this.facts.contextEdits++;
        return;
      case "session_info":
        this.facts.session.name = entry.name || undefined;
        return;
      case "custom": {
        const { customType, data } = entry as { customType?: unknown; data?: { status?: unknown } };
        if (customType === "subagents:record" && typeof data?.status === "string") {
          this.facts.subagentRuns[data.status] = (this.facts.subagentRuns[data.status] ?? 0) + 1;
        }
        return;
      }
      default:
        return;
    }
  }

  private systemMessage(line: Buffer): void {
    const { markers } = this.facts;
    markers.systemMessage = true;
    if (!markers.pignaTools) markers.pignaTools = namesPignaTools(line);
  }

  private header(header: SessionHeader): void {
    const session = this.facts.session;
    if (session.id) return;
    session.id = header.id;
    session.cwd = typeof header.cwd === "string" ? header.cwd : "";
    session.parentId = typeof header.parentSession === "string" ? header.parentSession : undefined;
    this.tick(Date.parse(header.timestamp));
  }

  /** Gaps between consecutive timed entries, each capped; a gap inside a prompt also counts toward its wall time. */
  private tick(at: number): void {
    if (!Number.isFinite(at)) return;
    const session = this.facts.session;
    if (session.lastAt > 0) {
      const capped = Math.min(Math.max(0, at - session.lastAt), ACTIVE_GAP_CAP_MS);
      session.activeMs += capped;
      if (this.facts.resume.open) this.facts.resume.open.wallMs += capped;
    } else {
      session.firstAt = at;
    }
    session.lastAt = at;
  }

  private turn(message: TurnMessage, entryAt: number): void {
    const when = Number.isFinite(message.timestamp) ? message.timestamp : entryAt;
    if (!Number.isFinite(when)) {
      this.facts.skipped.entries++;
      return;
    }
    const usage = message.usage;
    const tokens: TokenCounts = {
      input: num(usage?.input),
      output: num(usage?.output),
      cacheRead: num(usage?.cacheRead),
      cacheWrite: num(usage?.cacheWrite),
      reasoning: num(usage?.reasoning),
    };
    const context = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    const bucket = this.bucket(Math.floor(when / HOUR_MS), text(message.provider), text(message.model));
    bucket.turns++;
    addTokens(bucket.tokens, tokens);
    if (context > CONTEXT_TIER_EDGE) addTokens(bucket.tierTokens, tokens);
    bucket.recordedCost += num(usage?.cost?.total);
    if (tokens.cacheRead === 0 && context >= CACHE_MISS_MIN_INPUT) bucket.missTurns++;

    const stop = isStopReason(message.stopReason) ? message.stopReason : undefined;
    if (stop) this.facts.stops[stop] = (this.facts.stops[stop] ?? 0) + 1;
    const hasError = typeof message.errorMessage === "string" && message.errorMessage !== "";
    if (hasError || stop === "error" || stop === "aborted") {
      bucket.errorTurns++;
      const category = errorCategory(message.errorMessage, stop);
      this.facts.errors[category] = (this.facts.errors[category] ?? 0) + 1;
    }
    if (context > 0) bump(this.facts.contextHist, binOf(CONTEXT_EDGES, context));
    if (typeof message.thinkingLevel === "string") {
      this.facts.thinking[message.thinkingLevel] = (this.facts.thinking[message.thinkingLevel] ?? 0) + 1;
    }

    let calls = 0;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall") continue;
      calls++;
      this.tool(block.name).calls++;
      this.facts.resume.pending[block.id] = { name: block.name, at: when };
    }
    const open = this.facts.resume.open;
    if (open) {
      open.steps++;
      open.toolCalls += calls;
      open.aborted = stop === "aborted";
    }
  }

  private toolResult(message: ToolResultRecord): void {
    const nested = Array.isArray(message.nestedCalls?.calls) ? message.nestedCalls.calls.length : 0;
    if (nested > 0 && typeof message.toolName === "string") this.tool(message.toolName).nestedCalls += nested;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const call: PendingCall | undefined = id === undefined ? undefined : this.facts.resume.pending[id];
    if (!id || !call) return;
    delete this.facts.resume.pending[id];
    const stat = this.tool(call.name);
    if (message.isError) stat.errors++;
    const duration = message.timestamp - call.at;
    if (Number.isFinite(duration) && duration >= 0) {
      stat.timedCalls++;
      stat.durationMs += duration;
    }
  }

  private tool(name: string): ToolStat {
    const tools = this.facts.tools;
    tools[name] ??= { calls: 0, errors: 0, timedCalls: 0, durationMs: 0, nestedCalls: 0 };
    return tools[name];
  }

  private bucket(hour: number, provider: string, model: string): UsageBucket {
    const key = bucketKey(hour, provider, model);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        hour,
        provider,
        model,
        turns: 0,
        errorTurns: 0,
        missTurns: 0,
        recordedCost: 0,
        tokens: zeroTokens(),
        tierTokens: zeroTokens(),
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private openPrompt(): void {
    this.facts.resume.open = { steps: 0, toolCalls: 0, wallMs: 0, aborted: false };
  }

  private closePrompt(): void {
    const { resume } = this.facts;
    const open = resume.open;
    if (!open) return;
    const closed = resume.closed;
    closed.count++;
    closed.aborted += open.aborted ? 1 : 0;
    closed.steps += open.steps;
    closed.toolCalls += open.toolCalls;
    closed.wallMs += open.wallMs;
    bump(closed.stepHist, binOf(STEP_EDGES, open.steps));
    resume.open = undefined;
  }
}

function emptyFacts(target: ExtractTarget): FileUsageFacts {
  return {
    version: USAGE_FACTS_VERSION,
    size: 0,
    mtimeMs: 0,
    consumedBytes: 0,
    session: {
      id: "",
      root: target.root,
      path: target.path,
      surface: "terminal",
      pigna: false,
      cwd: "",
      project: "",
      firstAt: 0,
      lastAt: 0,
      activeMs: 0,
    },
    markers: { systemMessage: false, pignaTools: false, atpRuntime: false },
    buckets: [],
    tools: {},
    stops: {},
    errors: {},
    contextHist: zeros(CONTEXT_EDGES.length + 1),
    thinking: {},
    prompts: emptyPrompts(),
    compactions: 0,
    compactedTokens: 0,
    contextEdits: 0,
    subagentRuns: {},
    skipped: { lines: 0, entries: 0 },
    resume: { pending: {}, closed: emptyPrompts() },
  };
}

function emptyPrompts(): PromptStats {
  return { count: 0, aborted: 0, steps: 0, toolCalls: 0, wallMs: 0, stepHist: zeros(STEP_EDGES.length + 1) };
}

/** The closed prompts plus the open one, as the facts store them; the open prompt is recounted on every read. */
function promptView(resume: UsageResume): PromptStats {
  const view: PromptStats = { ...resume.closed, stepHist: [...resume.closed.stepHist] };
  const open = resume.open;
  if (!open) return view;
  view.count++;
  view.aborted += open.aborted ? 1 : 0;
  view.steps += open.steps;
  view.toolCalls += open.toolCalls;
  view.wallMs += open.wallMs;
  bump(view.stepHist, binOf(STEP_EDGES, open.steps));
  return view;
}

function headTimestamp(head: string): number | undefined {
  const match = ENTRY_TIMESTAMP.exec(head);
  if (!match) return undefined;
  const at = Date.parse(match[1] ?? "");
  return Number.isFinite(at) ? at : undefined;
}

function errorCategory(message: string | undefined, stop: StopReason | undefined): ErrorCategory {
  if (message) {
    for (const [pattern, category] of ERROR_RULES) if (pattern.test(message)) return category;
  }
  return stop === "aborted" ? "aborted" : "other";
}

function isStopReason(value: unknown): value is StopReason {
  return (STOP_REASONS as readonly unknown[]).includes(value);
}

/** Index of the first edge the value does not exceed; the last bin holds everything above the final edge. */
function binOf(edges: readonly number[], value: number): number {
  let index = 0;
  while (index < edges.length && value > (edges[index] ?? Infinity)) index++;
  return index;
}

function bump(counts: number[], index: number): void {
  counts[index] = (counts[index] ?? 0) + 1;
}

function bucketKey(hour: number, provider: string, model: string): string {
  return JSON.stringify([hour, provider, model]);
}

function compareBuckets(a: UsageBucket, b: UsageBucket): number {
  return a.hour - b.hour || compareText(a.provider, b.provider) || compareText(a.model, b.model);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addTokens(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
}

function zeros(length: number): number[] {
  return new Array<number>(length).fill(0);
}
