// The big payloads of a live chat's older turns (tool output, images) stay in its session file instead of main's
// state: main drops them once a turn is KEPT_TURNS turns back (`evictPayloads`), and a page that holds one reads it
// back from the file (`restorePayloads`), through an index of where each tool result and user image is in it.
import { type FileHandle, open } from "node:fs/promises";
import { jsonBytes } from "../shared/chat-page";
import type { AgentMessage, ImageContent, SessionEntry, TextContent, ToolResultLike, UserMessage } from "../shared/protocol";
import type { Item, ToolRun } from "../shared/session-state";
import { log } from "./log";

/** The turns at the end of a chat main keeps whole. */
export const KEPT_TURNS = 8;
/** Before them, a tool result of this much JSON or more is dropped; image data always is. */
export const EVICT_BYTES = 32 * 1024;

/** What a page shows where the file no longer has what main dropped (the file was deleted or rewritten). */
const GONE_OUTPUT: ToolResultLike = { content: [{ type: "text", text: "This output is no longer in the chat's session file." }] };
const GONE_IMAGE: TextContent = { type: "text", text: "[This image is no longer in the chat's session file.]" };

type Content = UserMessage["content"] | ToolResultLike["content"];
const hasImage = (content: Content) => Array.isArray(content) && content.some((block) => block.type === "image" && block.data.length > 0);

/**
 * Drop the big payloads of the turns before the last KEPT_TURNS, from item `from` on (the ones before went in an
 * earlier call): tool results of EVICT_BYTES or more or with an image, and the image data of user messages. `to` is
 * where the next call starts; `items` is the same array when nothing was dropped.
 */
export function evictPayloads(items: Item[], from: number): { items: Item[]; to: number } {
  let to = from;
  let prompts = 0;
  for (let index = items.length - 1; index >= from; index--) {
    const item = items[index]!;
    if (item.kind === "user" && !item.steer && ++prompts === KEPT_TURNS) {
      to = index;
      break;
    }
  }
  let next: Item[] | undefined;
  for (let index = from; index < to; index++) {
    const item = evictItem(items[index]!);
    if (item !== items[index]) (next ??= items.slice())[index] = item;
  }
  return { items: next ?? items, to };
}

function evictItem(item: Item): Item {
  if (item.kind === "assistant" && item.runs) {
    let runs: Record<string, ToolRun> | undefined;
    for (const [id, run] of Object.entries(item.runs)) {
      if (!run.result) continue;
      const bytes = jsonBytes(run.result);
      if (bytes < EVICT_BYTES && !hasImage(run.result.content)) continue;
      (runs ??= { ...item.runs })[id] = { status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, evicted: bytes };
    }
    return runs ? { ...item, runs } : item;
  }
  if (item.kind === "user" && hasImage(item.message.content)) {
    let bytes = 0;
    const content = (item.message.content as (TextContent | ImageContent)[]).map((block) => {
      if (block.type !== "image") return block;
      bytes += block.data.length;
      return { ...block, data: "" };
    });
    return { ...item, message: { ...item.message, content }, evicted: bytes };
  }
  return item;
}

/**
 * The items with what `evictPayloads` dropped read back from the chat's session files: the same array when nothing
 * was dropped. What a file no longer has shows as a line saying so.
 */
export async function restorePayloads(items: Item[], files: PayloadFiles): Promise<Item[]> {
  const tools = new Set<string>();
  const users = new Set<number>();
  for (const item of items) {
    if (item.kind === "assistant" && item.runs) for (const [id, run] of Object.entries(item.runs)) if (run.evicted !== undefined) tools.add(id);
    if (item.kind === "user" && item.evicted !== undefined) users.add(item.message.timestamp);
  }
  if (!tools.size && !users.size) return items;
  const found = await files.read(tools, users);
  const missing = tools.size - found.results.size + users.size - found.messages.size;
  if (missing) log.warn("payloads", `${missing} of ${tools.size + users.size} dropped payloads are not in ${files.paths.join(", ") || "any session file"}`);
  return items.map((item) => {
    if (item.kind === "assistant" && item.runs && Object.values(item.runs).some((run) => run.evicted !== undefined)) {
      const runs = { ...item.runs };
      for (const [id, { evicted, ...run }] of Object.entries(item.runs)) if (evicted !== undefined) runs[id] = { ...run, result: found.results.get(id) ?? GONE_OUTPUT };
      return { ...item, runs };
    }
    if (item.kind === "user" && item.evicted !== undefined) {
      const { evicted: _evicted, ...user } = item;
      const content = (item.message.content as (TextContent | ImageContent)[]).map((block) => (block.type === "image" ? GONE_IMAGE : block));
      return { ...user, message: found.messages.get(item.message.timestamp) ?? { ...item.message, content } };
    }
    return item;
  });
}

/** A chat's session files (pi moves a chat to another on /new, /resume and forks), each with its index, newest last. */
export class PayloadFiles {
  private readonly indexes = new Map<string, PayloadIndex>();

  /** The file pi writes the chat to now: looked in first. */
  use(path: string | undefined): void {
    if (!path) return;
    const index = this.indexes.get(path) ?? new PayloadIndex(path);
    this.indexes.delete(path);
    this.indexes.set(path, index);
  }

  get paths(): string[] {
    return [...this.indexes.keys()];
  }

  async read(tools: Set<string>, users: Set<number>): Promise<Found> {
    const found: Found = { results: new Map(), messages: new Map() };
    for (const index of [...this.indexes.values()].reverse()) {
      const wantedTools = [...tools].filter((id) => !found.results.has(id));
      const wantedUsers = [...users].filter((time) => !found.messages.has(time));
      if (!wantedTools.length && !wantedUsers.length) break;
      await index.read(wantedTools, wantedUsers, found);
    }
    return found;
  }
}

interface Found {
  results: Map<string, ToolResultLike>;
  messages: Map<number, UserMessage>;
}

// pi writes an entry as one JSON line, its type, id, parentId and timestamp before its message, and a message's role
// first: a line's head says what it is without parsing it.
const TOOL_RESULT = Buffer.from('"message":{"role":"toolResult","toolCallId":"');
const USER = Buffer.from('"message":{"role":"user",');
const IMAGE = Buffer.from('"type":"image"');
const HEAD_BYTES = 512;
const CHUNK_BYTES = 4 << 20;
const LF = 0x0a;
const QUOTE = 0x22;

/**
 * Where in a session file each tool result and each user message with an image is, by byte range. Built by one scan
 * the first time a page needs it and extended from where it stopped as pi appends; a file that shrank or no longer
 * has the line where the index says is scanned again.
 */
class PayloadIndex {
  /** Bytes indexed: up to the last whole line seen. */
  private indexed = 0;
  private tools = new Map<string, [number, number]>();
  private users = new Map<number, [number, number]>();
  /** Reads run one after the other: a scan extends the index the next read uses. */
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  read(tools: string[], users: number[], found: Found): Promise<void> {
    const run = this.queue.then(() => this.lookup(tools, users, found));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async lookup(tools: string[], users: number[], found: Found): Promise<void> {
    let file: FileHandle;
    try {
      file = await open(this.path, "r");
    } catch {
      return;
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { size } = await file.stat();
        if (size < this.indexed) this.reset();
        if (tools.some((id) => !this.tools.has(id)) || users.some((time) => !this.users.has(time))) await this.scan(file, size);
        let moved = false;
        for (const id of tools) {
          const range = this.tools.get(id);
          const message = range && (await readMessage(file, range));
          if (message?.role === "toolResult" && message.toolCallId === id) found.results.set(id, { content: message.content, details: message.details });
          else if (range) moved = true;
        }
        for (const time of users) {
          const range = this.users.get(time);
          const message = range && (await readMessage(file, range));
          if (message?.role === "user" && message.timestamp === time) found.messages.set(time, message);
          else if (range) moved = true;
        }
        if (!moved) return;
        // The file was rewritten in place: what the index says is elsewhere now.
        this.reset();
      }
    } catch (error) {
      // What it did not read shows as no longer there; the next page tries again.
      log.warn("payloads", `could not read ${this.path}: ${(error as Error).message}`);
    } finally {
      await file.close();
    }
  }

  private reset(): void {
    this.indexed = 0;
    this.tools = new Map();
    this.users = new Map();
  }

  /** Index the whole lines from `indexed` to `size`; a last line pi is still writing waits for the next scan. */
  private async scan(file: FileHandle, size: number): Promise<void> {
    let carry = Buffer.alloc(0);
    let base = this.indexed;
    let position = this.indexed;
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - position));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let end = buffer.indexOf(LF, start); end !== -1; end = buffer.indexOf(LF, start)) {
        this.note(buffer.subarray(start, end), base + start, base + end);
        start = end + 1;
      }
      carry = buffer.subarray(start);
      base += start;
      this.indexed = base;
    }
  }

  private note(line: Buffer, start: number, end: number): void {
    const head = line.subarray(0, HEAD_BYTES);
    const tool = head.indexOf(TOOL_RESULT);
    if (tool !== -1) {
      const from = tool + TOOL_RESULT.length;
      const close = line.indexOf(QUOTE, from);
      if (close > from) this.tools.set(line.toString("latin1", from, close), [start, end]);
      return;
    }
    if (head.indexOf(USER) === -1 || line.indexOf(IMAGE) === -1) return;
    const message = parseMessage(line);
    if (message?.role === "user") this.users.set(message.timestamp, [start, end]);
  }
}

async function readMessage(file: FileHandle, [start, end]: [number, number]): Promise<AgentMessage | undefined> {
  const line = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await file.read(line, 0, line.length, start);
  return bytesRead === line.length ? parseMessage(line) : undefined;
}

function parseMessage(line: Buffer): AgentMessage | undefined {
  try {
    const entry = JSON.parse(line.toString("utf8")) as SessionEntry;
    return entry.type === "message" ? entry.message : undefined;
  } catch {
    return undefined;
  }
}
