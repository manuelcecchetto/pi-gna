// A chat's subagents as its session files tell them (src/shared/subagents.ts joins them), and a subagent's transcript.
// pi-subagents keeps each agent's session at `<chat file without .jsonl>/tasks/<ts>_<id>.jsonl` under pi's sessions
// folder. The chat's own file is read only past what an earlier listing read (pi only appends), and only its lines that
// mention subagents are parsed; a child file is read again only when it changed.
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SessionEntry } from "../shared/protocol";
import { createSession, hydrate } from "../shared/session-state";
import { type ChildFacts, joinSubagents, type ParentFacts, shortArgs, type SpawnCall, type Subagent, type SubagentTranscript } from "../shared/subagents";
import { parseRecords, activeBranch } from "./session-file";
import { sessionsDir } from "./session-index";

/** `<sessions>/<project dir>/<chat>.jsonl`: a chat file in pi's sessions folder, or undefined. */
export function chatFileIn(root: string, path: string): string | undefined {
  const full = resolve(path);
  const parts = relative(root, full).split(sep);
  return parts.length === 2 && parts[0] && !parts[0].startsWith("..") && parts[1]!.endsWith(".jsonl") ? full : undefined;
}

/** `<sessions>/<project dir>/<chat>/tasks/<agent>.jsonl`: a subagent's file in pi's sessions folder, or undefined. */
export function subagentFileIn(root: string, path: string): string | undefined {
  const full = resolve(path);
  const parts = relative(root, full).split(sep);
  return parts.length === 4 && parts[0] && !parts[0].startsWith("..") && parts[2] === "tasks" && parts[3]!.endsWith(".jsonl") ? full : undefined;
}

/** Where a chat's subagents keep their files. */
export const tasksDir = (chatFile: string): string => join(dirname(chatFile), basename(chatFile, ".jsonl"), "tasks");

/** How many subagent files a chat has; 0 without a tasks folder. */
export async function countSubagents(chatFile: string): Promise<number> {
  const names = await readdir(tasksDir(chatFile)).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".jsonl")).length;
}

interface ParentScan {
  /** Bytes read so far, always at a line start. */
  offset: number;
  facts: ParentFacts;
  /** Spawn calls by id, for their results. */
  calls: Map<string, SpawnCall>;
}

const parents = new Map<string, ParentScan>();
const children = new Map<string, { size: number; mtimeMs: number; facts: ChildFacts }>();
/** Lines that may concern subagents; the rest of a chat's file is not parsed. */
const MENTIONS = /"name":"subagent"|"toolName":"(?:subagent|get_subagent_result)"|"customType":"subagents:record"/;
const CHUNK = 1024 * 1024;

type Line = {
  type?: string;
  timestamp?: string;
  customType?: string;
  data?: { id?: unknown; status?: unknown; startedAt?: unknown; completedAt?: unknown; error?: unknown };
  message?: { role?: string; toolName?: string; toolCallId?: string; details?: Record<string, unknown>; content?: unknown; timestamp?: number };
};

function readLine(scan: ParentScan, text: string): void {
  if (!MENTIONS.test(text)) return;
  let line: Line;
  try {
    line = JSON.parse(text) as Line;
  } catch {
    return;
  }
  const at = Date.parse(line.timestamp ?? "") || 0;
  if (line.type === "custom" && line.customType === "subagents:record") {
    const data = line.data ?? {};
    if (typeof data.id !== "string" || typeof data.status !== "string") return;
    scan.facts.records.push({
      id: data.id,
      status: data.status,
      ...(typeof data.startedAt === "number" && { startedAt: data.startedAt }),
      ...(typeof data.completedAt === "number" && { completedAt: data.completedAt }),
      ...(typeof data.error === "string" && { error: data.error }),
    });
    return;
  }
  const message = line.message;
  if (line.type !== "message" || !message) return;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
      if (block.type !== "toolCall" || block.name !== "subagent" || typeof block.id !== "string") continue;
      const args = block.arguments ?? {};
      const str = (value: unknown) => (typeof value === "string" ? value : undefined);
      const spawn: SpawnCall = {
        callId: block.id,
        at: message.timestamp ?? at,
        args: { description: str(args.description), subagent_type: str(args.subagent_type), prompt: str(args.prompt), resume: str(args.resume), model: str(args.model) },
      };
      scan.calls.set(block.id, spawn);
      scan.facts.spawns.push(spawn);
    }
    return;
  }
  if (message.role !== "toolResult") return;
  const details = message.details ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  if (message.toolName === "subagent") {
    const spawn = message.toolCallId ? scan.calls.get(message.toolCallId) : undefined;
    if (spawn) spawn.result = { agentId: str(details.agentId), modelName: str(details.modelName), status: str(details.status), error: str(details.error) };
  } else if (message.toolName === "get_subagent_result") {
    const agentId = str(details.agentId);
    const path = str(details.transcriptPath);
    if (agentId && path) scan.facts.transcripts.push({ agentId, path });
  }
}

/** What the chat's file says about its subagents; reads only what was appended since the last call. */
export async function readParentFacts(chatFile: string): Promise<ParentFacts> {
  let scan = parents.get(chatFile);
  const size = (await stat(chatFile)).size;
  if (!scan || size < scan.offset) {
    scan = { offset: 0, facts: { spawns: [], records: [], transcripts: [] }, calls: new Map() };
    parents.set(chatFile, scan);
  }
  if (size === scan.offset) return scan.facts;
  const file = await open(chatFile, "r");
  try {
    let rest = Buffer.alloc(0);
    let position = scan.offset;
    while (position < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = rest.length ? Buffer.concat([rest, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        readLine(scan, data.toString("utf8", start, end));
        start = end + 1;
      }
      rest = Buffer.from(data.subarray(start));
    }
    // A line pi is still writing is read next time, from its start.
    scan.offset = position - rest.length;
  } finally {
    await file.close();
  }
  return scan.facts;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[]).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

/** What a subagent's file says about it. */
export async function readChildFacts(file: string): Promise<ChildFacts | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  const cached = children.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.facts;
  const handle = await open(file, "r");
  let text: string;
  try {
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const facts: ChildFacts = { file, id: basename(file, ".jsonl"), startedAt: info.birthtimeMs, prompts: [], toolUses: 0, tokens: 0 };
  for (const record of parseRecords(text) as Line[]) {
    if (record.type === "session") {
      const header = record as { id?: unknown; timestamp?: string };
      if (typeof header.id === "string") facts.id = header.id;
      facts.startedAt = Date.parse(header.timestamp ?? "") || facts.startedAt;
      continue;
    }
    const message = record.message as
      | { role?: string; content?: unknown; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheWrite?: number } }
      | undefined;
    if (record.type !== "message" || !message) continue;
    if (message.role === "user") facts.prompts.push(userText(message.content));
    else if (message.role === "toolResult") facts.toolUses += 1;
    else if (message.role === "assistant") {
      const usage = message.usage ?? {};
      facts.tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
      if (message.provider && message.model) facts.model = `${message.provider}/${message.model}`;
      const calls = Array.isArray(message.content) ? (message.content as { type?: string; name?: string; arguments?: Record<string, unknown> }[]).filter((block) => block.type === "toolCall" && block.name) : [];
      const call = calls.at(-1);
      if (call) facts.last = { name: call.name!, args: shortArgs(call.arguments ?? {}) };
    }
  }
  children.set(file, { size: info.size, mtimeMs: info.mtimeMs, facts });
  return facts;
}

/** A chat's subagents from its files, newest first; none when it never had any. */
export async function listSubagents(chatFile: string): Promise<Subagent[]> {
  const dir = tasksDir(chatFile);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
  if (!names.length) return [];
  const [parent, files] = await Promise.all([readParentFacts(chatFile), Promise.all(names.map((name) => readChildFacts(join(dir, name))))]);
  return joinSubagents(parent, files.filter((facts): facts is ChildFacts => facts !== undefined));
}

/** A subagent's transcript, or `unchanged` when its file still has `knownSize` bytes. */
export async function readSubagentTranscript(file: string, knownSize?: number): Promise<{ size: number; transcript?: SubagentTranscript }> {
  const size = (await stat(file)).size;
  if (size === knownSize) return { size };
  const handle = await open(file, "r");
  let text: string;
  try {
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const records = parseRecords(text);
  const header = records.find((record) => record.type === "session") as { cwd?: string } | undefined;
  const state = hydrate(createSession("subagent", header?.cwd ?? dirname(file), file), activeBranch(records) as SessionEntry[]);
  return { size, transcript: { items: state.items, modelRef: state.modelRef, thinkingLevel: state.thinkingLevel, cwd: state.cwd } };
}

/** The checks of the host methods: paths inside pi's sessions folder, of the right shape. */
export function checkedChatFile(path: unknown): string {
  const file = typeof path === "string" && path.length <= 4096 ? chatFileIn(sessionsDir(), path) : undefined;
  if (!file) throw new Error("Invalid chat");
  return file;
}

export function checkedSubagentFile(path: unknown): string {
  const file = typeof path === "string" && path.length <= 4096 ? subagentFileIn(sessionsDir(), path) : undefined;
  if (!file) throw new Error("Invalid subagent");
  return file;
}
