// Writing an imported chat as a pi session file (pi's session format v3): where pi itself would keep a chat of that
// folder, under an id derived from the source chat, so importing again finds it. The file's mtime is the source
// chat's last activity: the sidebar orders chats and projects by mtime, and an import must not jump ahead of the
// chats you had today.
import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IMPORT_ENTRY_TYPE, type ImportMarker } from "../../shared/chat-import";
import type { ToolResultMessage } from "../../shared/protocol";
import type { ImportedEntry, SourceChat } from "./common";

/** pi's folder for a cwd's sessions (`getDefaultSessionDirPath` in pi's session-manager). */
export function sessionFolder(sessionsDir: string, cwd: string): string {
  return join(sessionsDir, `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** A UUID-shaped id that is the same every time the same source chat is imported. */
export function importedSessionId(chat: Pick<SourceChat, "source" | "id">): string {
  const hex = createHash("sha256").update(`${chat.source}:${chat.id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 17), 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function importedSessionPath(sessionsDir: string, chat: SourceChat): string {
  const created = new Date(chat.createdAt).toISOString();
  return join(sessionFolder(sessionsDir, chat.cwd), `${created.replace(/[:.]/g, "-")}_${importedSessionId(chat)}.jsonl`);
}

export type ImportState = "fresh" | "changed" | "current" | "continued";

/** What importing `chat` to `path` would do: the marker records what was imported and the mtime the file was given. */
export async function importState(path: string, chat: SourceChat): Promise<ImportState> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return "fresh";
  }
  const marker = await readMarker(path);
  if (!marker) return "continued";
  // pi appended to it (the chat went on in pi), so it is yours now.
  if (Math.abs(mtimeMs - marker.mtimeMs) > 1) return "continued";
  return marker.size === chat.size && Math.abs(marker.mtimeMs - chat.mtimeMs) <= 1 ? "current" : "changed";
}

async function readMarker(path: string): Promise<ImportMarker | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 3)) {
      try {
        const record = JSON.parse(line);
        if (record?.type === "custom" && record.customType === IMPORT_ENTRY_TYPE) return record.data as ImportMarker;
      } catch {
        // a cut line
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Every tool call answered by the results right after its message, as the providers require: a result whose call is
 * not in the answer just before it is dropped, and a call with no result (an aborted turn) gets one saying so.
 */
export function pairToolResults(entries: ImportedEntry[]): ImportedEntry[] {
  const out: ImportedEntry[] = [];
  let pending = new Map<string, string>();
  let time = 0;
  const close = () => {
    for (const [id, name] of pending) {
      const result: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "(no result was recorded)" }], isError: true, timestamp: time };
      out.push({ kind: "message", message: result });
    }
    pending = new Map();
  };
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "toolResult") {
      if (pending.delete(entry.message.toolCallId)) out.push(entry);
      continue;
    }
    close();
    out.push(entry);
    if (entry.kind === "message") {
      time = entry.message.timestamp;
      if (entry.message.role === "assistant") for (const block of entry.message.content) if (block.type === "toolCall") pending.set(block.id, block.name);
    }
  }
  close();
  return out;
}

/** The session file's lines. */
export function sessionLines(chat: SourceChat, entries: ImportedEntry[]): string[] {
  const iso = (time: number) => new Date(Number.isFinite(time) ? time : chat.createdAt).toISOString();
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: importedSessionId(chat), timestamp: iso(chat.createdAt), cwd: chat.cwd })];
  let n = 0;
  let parentId: string | null = null;
  const push = (entry: Record<string, unknown>, timestamp: number) => {
    const id = (++n).toString(16).padStart(8, "0");
    lines.push(JSON.stringify({ type: entry.type, id, parentId, timestamp: iso(timestamp), ...entry }));
    parentId = id;
    return id;
  };
  const marker: ImportMarker = { source: chat.source, id: chat.id, file: chat.file, size: chat.size, mtimeMs: chat.mtimeMs };
  push({ type: "custom", customType: IMPORT_ENTRY_TYPE, data: marker }, chat.createdAt);
  if (chat.title) push({ type: "session_info", name: chat.title }, chat.createdAt);
  const paired = pairToolResults(entries);
  paired.forEach((entry, index) => {
    if (entry.kind === "message") {
      push({ type: "message", message: entry.message }, entry.message.timestamp);
      return;
    }
    // pi keeps the entries after a compaction (and from firstKeptEntryId) in the model's context: the next entry on.
    if (index === paired.length - 1) return;
    const firstKept = (n + 2).toString(16).padStart(8, "0");
    push({ type: "compaction", summary: entry.summary, firstKeptEntryId: firstKept, tokensBefore: 0 }, entry.timestamp);
  });
  return lines;
}

/** Writes the session through a temp file beside it, then gives it the source chat's mtime. */
export async function writeImportedSession(path: string, chat: SourceChat, entries: ImportedEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.import-tmp`;
  try {
    await writeFile(temp, `${sessionLines(chat, entries).join("\n")}\n`);
    const time = new Date(chat.mtimeMs);
    await utimes(temp, time, time);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
