// Codex's history: one rollout JSONL per thread under $CODEX_HOME/sessions/YYYY/MM/DD (default ~/.codex). The first
// line (session_meta) says where the thread came from; session_index.jsonl holds the names Codex gave them.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "../../shared/protocol";
import {
  assistantMessage,
  EntryBuilder,
  forEachLimit,
  IMAGE_PLACEHOLDER,
  type ImportedEntry,
  jsonRecords,
  mapToolCall,
  parseArguments,
  parseLine,
  type SourceChat,
  thinking,
  timeOf,
  toolResult,
  userMessage,
} from "./common";

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** Where a thread came from, per its session_meta: `source` is "cli", "vscode", "exec" or `{ subagent: … }`. */
export function isPersonsCodexThread(meta: Record<string, unknown>): boolean {
  if (typeof meta.source !== "string" || meta.source === "exec") return false;
  return !["subagent", "agent_created_thread", "guardian_review"].includes(String(meta.thread_source ?? ""));
}

/** The first line of a file, read in growing chunks (a rollout's session_meta is tens of KB). */
async function firstLine(file: string, limit = 4 * 1024 * 1024): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    let length = 64 * 1024;
    for (;;) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end >= 0) return buffer.subarray(0, end).toString("utf8");
      if (bytesRead < length) return buffer.subarray(0, bytesRead).toString("utf8");
      if (length >= limit) return undefined;
      length *= 4;
    }
  } finally {
    await handle.close();
  }
}

async function threadNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const text = await readFile(join(home, "session_index.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const record = parseLine(line);
    if (typeof record?.id === "string" && typeof record.thread_name === "string" && record.thread_name.trim()) names.set(record.id, record.thread_name.trim());
  }
  return names;
}

export interface SourceListing {
  root: string;
  found: boolean;
  chats: SourceChat[];
  skipped: number;
}

export async function listCodex(home = codexHome()): Promise<SourceListing> {
  const root = join(home, "sessions");
  let files: string[];
  try {
    files = (await readdir(root, { recursive: true })).filter((path) => /(^|[/\\])rollout-[^/\\]*\.jsonl$/.test(path)).map((path) => join(root, path));
  } catch {
    return { root, found: false, chats: [], skipped: 0 };
  }
  const names = await threadNames(home);
  const chats: SourceChat[] = [];
  let skipped = 0;
  await forEachLimit(files, 16, async (file) => {
    try {
      const info = await stat(file);
      const meta = parseLine((await firstLine(file)) ?? "");
      const payload = meta?.type === "session_meta" ? (meta.payload as Record<string, unknown>) : undefined;
      const id = typeof payload?.id === "string" ? payload.id : undefined;
      if (!payload || !id || typeof payload.cwd !== "string" || !isPersonsCodexThread(payload)) {
        skipped++;
        return;
      }
      chats.push({ source: "codex", id, file, cwd: payload.cwd, title: names.get(id), createdAt: timeOf(payload.timestamp, info.birthtimeMs), mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      skipped++;
    }
  });
  return { root, found: true, chats, skipped };
}

/**
 * An answer without Codex Desktop's markup, which its window draws as chips: action directives on their own
 * (`::git-commit{cwd="…"}`) and memory citations (`<oai-mem-citation>…</oai-mem-citation>`).
 */
export function withoutCodexMarkup(text: string): string {
  return text
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/(^|[ \t])::[a-z][\w-]*\{[^}\n]*\}/gm, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text of a tool output: a string, Codex's older `{ output, metadata: { exit_code } }` JSON, or content parts. */
function outputOf(raw: unknown): { text: string; isError: boolean } {
  if (typeof raw === "string") {
    const parsed = raw.startsWith("{") ? parseLine(raw) : undefined;
    if (parsed && typeof parsed.output === "string") {
      const code = parsed.metadata?.exit_code;
      return { text: parsed.output, isError: typeof code === "number" && code !== 0 };
    }
    return { text: raw, isError: false };
  }
  const parts = Array.isArray(raw) ? raw : Array.isArray((raw as { content?: unknown })?.content) ? (raw as { content: unknown[] }).content : [];
  const texts = parts.map((part: any) => (typeof part?.text === "string" ? part.text : part?.type === "input_image" || part?.type === "image" ? IMAGE_PLACEHOLDER : "")).filter(Boolean);
  return { text: texts.join("\n"), isError: false };
}

/** Codex keeps its compaction summary encrypted; what it hands the model besides it is the person's earlier messages. */
function compactionSummary(payload: Record<string, any>): string {
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  const asked: string[] = [];
  for (const item of Array.isArray(payload.replacement_history) ? payload.replacement_history : []) {
    if (item?.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) continue;
    const text = userMessage(item.content.map((part: any) => (typeof part?.text === "string" ? { text: part.text } : {})), 0)?.content;
    const joined = Array.isArray(text) ? text.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim() : "";
    if (joined) asked.push(joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined);
  }
  const intro = "Codex compacted the conversation here. Its summary is encrypted, so it could not be imported; the messages above are shown for reference.";
  if (asked.length === 0) return intro;
  let list = "";
  for (const text of asked.reverse()) {
    if (list.length + text.length > 12_000) break;
    list = `- ${text.replace(/\n/g, "\n  ")}\n${list}`;
  }
  return `${intro}\n\nThe user's earlier messages:\n\n${list}`;
}

export async function readCodex(chat: SourceChat): Promise<ImportedEntry[]> {
  let model = "unknown";
  let now = chat.createdAt;
  const calls = new Map<string, ToolCall>();
  const builder = new EntryBuilder(() => assistantMessage("codex", "openai-responses", model, now));
  const call = (id: unknown, name: unknown, args: Record<string, unknown>) => {
    if (typeof id !== "string" || typeof name !== "string") return;
    const mapped = mapToolCall(id, name, args);
    calls.set(id, mapped);
    builder.block(mapped);
  };
  for await (const record of jsonRecords(chat.file)) {
    now = timeOf(record.timestamp, now);
    const p = (record.payload ?? {}) as Record<string, any>;
    if (record.type === "turn_context") {
      if (typeof p.model === "string") model = p.model;
      continue;
    }
    if (record.type === "compacted") {
      builder.compaction(compactionSummary(p), now);
      continue;
    }
    if (record.type !== "response_item") continue;
    switch (p.type) {
      case "message": {
        const content: any[] = Array.isArray(p.content) ? p.content : [];
        if (p.role === "user") {
          builder.user(userMessage(content.map((part) => (part?.type === "input_image" ? { image: true as const } : typeof part?.text === "string" ? { text: part.text } : {})), now));
        } else if (p.role === "assistant") {
          for (const part of content) {
            const text = typeof part?.text === "string" ? withoutCodexMarkup(part.text) : "";
            if (text) builder.block({ type: "text", text });
          }
        }
        break;
      }
      case "reasoning": {
        const summary: any[] = Array.isArray(p.summary) ? p.summary : [];
        builder.block(thinking(summary.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n\n")));
        break;
      }
      case "function_call":
        call(p.call_id ?? p.id, p.name, parseArguments(p.arguments));
        break;
      case "custom_tool_call":
        call(p.call_id ?? p.id, p.name, parseArguments(p.input));
        break;
      case "local_shell_call":
        call(p.call_id ?? p.id, "local_shell", { command: p.action?.command });
        break;
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        const known = typeof p.call_id === "string" ? calls.get(p.call_id) : undefined;
        if (!known) break;
        const { text, isError } = outputOf(p.output);
        builder.result(toolResult(known, text, isError, now));
        break;
      }
    }
  }
  return builder.finish();
}
