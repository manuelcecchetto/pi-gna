// Read pi session files directly. RPC has no list_sessions command, and reading the file lets
// a transcript render before its pi process finishes booting.
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { SessionEntry, SessionHeader } from "../shared/protocol";
import { JsonlSplitter } from "./jsonl";

type FileRecord = SessionHeader | SessionEntry;

export function parseRecords(text: string): FileRecord[] {
  const splitter = new JsonlSplitter();
  const records: FileRecord[] = [];
  for (const line of [...splitter.push(text), ...splitter.end()]) {
    try {
      records.push(JSON.parse(line) as FileRecord);
    } catch {
      // A torn final line (pi still writing) is skipped; the next read picks it up.
    }
  }
  return records;
}

/** Entry types the transcript never renders; dropped before crossing IPC. */
const HIDDEN_TYPES = new Set(["custom", "usage", "context_edit", "label"]);

/**
 * The active branch, root -> leaf. pi treats the last appended entry as the leaf when it loads a
 * session, so we do the same. System messages (full prompt + tool schemas) are dropped.
 */
export function activeBranch(records: FileRecord[]): SessionEntry[] {
  const entries = records.filter((record): record is SessionEntry => record.type !== "session" && "id" in record);
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let cursor: SessionEntry | undefined = leaf;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return branch.reverse().filter((entry) => !isHidden(entry));
}

function isHidden(entry: SessionEntry): boolean {
  if (HIDDEN_TYPES.has(entry.type)) return true;
  return entry.type === "message" && entry.message.role === "system";
}

export async function readActiveBranch(path: string): Promise<SessionEntry[]> {
  return activeBranch(parseRecords(await readFile(path, "utf8")));
}

export interface SessionFileSummary {
  header: SessionHeader;
  title: string | undefined;
  name: string | undefined;
}

const HEAD_LIMIT = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

/**
 * Header, first user message and latest name, without reading whole (often multi-MB) files.
 * The first user message follows a ~100 KB system message, so the head is streamed until found.
 */
export async function summarizeSessionFile(path: string, size: number): Promise<SessionFileSummary | undefined> {
  let header: SessionHeader | undefined;
  let title: string | undefined;
  let name: string | undefined;

  const stream = createReadStream(path, { end: HEAD_LIMIT - 1 });
  const splitter = new JsonlSplitter();
  try {
    outer: for await (const chunk of stream) {
      for (const line of splitter.push(chunk as Buffer)) {
        const record = safeParse(line);
        if (!record) continue;
        if (record.type === "session") header = record;
        else if (record.type === "session_info") name = record.name;
        else if (record.type === "message" && record.message.role === "user") {
          title = textOf(record.message.content);
          break outer;
        }
      }
    }
  } finally {
    stream.destroy();
  }
  if (!header) return undefined;

  if (size > HEAD_LIMIT || title !== undefined) {
    const tailName = await latestNameInTail(path, size);
    if (tailName !== undefined) name = tailName || undefined;
  }
  return { header, title, name };
}

async function latestNameInTail(path: string, size: number): Promise<string | undefined> {
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    let name: string | undefined;
    // Skip the first (possibly partial) line when reading from the middle of the file.
    const lines = text.split("\n").slice(start > 0 ? 1 : 0);
    for (const line of lines) {
      if (!line.includes('"session_info"')) continue;
      const record = safeParse(line);
      if (record?.type === "session_info") name = record.name ?? "";
    }
    return name;
  } finally {
    await handle.close();
  }
}

function safeParse(line: string): FileRecord | undefined {
  try {
    return JSON.parse(line) as FileRecord;
  } catch {
    return undefined;
  }
}

export function textOf(content: string | { type: string; text?: string }[]): string {
  const full = typeof content === "string" ? content : content.find((block) => block.type === "text")?.text ?? "";
  // Drop the blocks pi studio appends to prompts (file mentions, browser comments).
  const raw = full.split(/\n*(?:# Files mentioned by the user:|<browser-comments>)/)[0] ?? full;
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}
