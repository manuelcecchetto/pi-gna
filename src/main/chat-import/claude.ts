// Claude Code's history: one JSONL per session under $CLAUDE_CONFIG_DIR/projects/<cwd as dashes>/ (default
// ~/.claude). Most of a pi-gna user's files there are not chats they typed: pi-claude-bridge runs Claude Code for
// every claude-bridge chat, and scripts run it through the Agent SDK or `claude -p`. Only a person's sessions list.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { projectOf } from "../../shared/board";
import type { ToolCall } from "../../shared/protocol";
import type { SourceListing } from "./codex";
import {
  assistantMessage,
  EntryBuilder,
  forEachLimit,
  IMAGE_PLACEHOLDER,
  type ImportedEntry,
  jsonRecords,
  mapToolCall,
  NotAPersonsChat,
  parseLine,
  sampleLines,
  type SourceChat,
  thinking,
  timeOf,
  toolResult,
  userMessage,
} from "./common";

export function claudeProjects(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Claude Code's own front ends; the Agent SDK reports `sdk-ts`/`sdk-py` and `claude -p` reports `sdk-cli`. */
const PERSON_ENTRYPOINTS = new Set(["cli", "claude-desktop"]);
/** pi-claude-bridge gives Claude Code pi's tools through this MCP server. */
const BRIDGE_TOOL_PREFIX = "mcp__custom-tools__";
/** A project folder of a chat run in a pi-gna card worktree (~/.pi-gna/worktrees/…), as Claude Code names it. */
const WORKTREE_FOLDER = /[-.]pi-gna-worktrees-/;
const SAMPLE_BYTES = 64 * 1024;

export interface ClaudeSample {
  entrypoint: string;
  cwd: string;
  /** Some sampled user record has no `promptId`, which Claude Code writes on every turn it records itself. */
  unprompted: boolean;
  bridgeTools: boolean;
  messages: number;
  title?: string;
  createdAt?: number;
}

export function sampleClaude(lines: string[]): ClaudeSample {
  const sample: ClaudeSample = { entrypoint: "", cwd: "", unprompted: false, bridgeTools: false, messages: 0 };
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  for (const line of lines) {
    const record = parseLine(line);
    if (!record) continue;
    if (!sample.entrypoint && typeof record.entrypoint === "string") sample.entrypoint = record.entrypoint;
    if (!sample.cwd && typeof record.cwd === "string") sample.cwd = record.cwd;
    if (sample.createdAt === undefined && typeof record.timestamp === "string") sample.createdAt = timeOf(record.timestamp, Number.NaN);
    if (record.type === "custom-title" && typeof record.customTitle === "string") customTitle = record.customTitle;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") aiTitle = record.aiTitle;
    if (record.type !== "user" && record.type !== "assistant") continue;
    sample.messages++;
    if (record.type === "user" && typeof record.promptId !== "string") sample.unprompted = true;
    if (record.type === "assistant" && hasBridgeTool(record)) sample.bridgeTools = true;
  }
  sample.title = (customTitle ?? aiTitle)?.trim() || undefined;
  return sample;
}

/**
 * A session a person typed into. The bridge rebuilds its transcripts with cc-session-io, which writes
 * `entrypoint: "cli"` but no `promptId`; its live sessions call `mcp__custom-tools__*`. Fails closed: a sample with
 * no entrypoint is not listed.
 */
export function isPersonsClaudeSession(sample: ClaudeSample): boolean {
  if (sample.messages === 0 || sample.unprompted || sample.bridgeTools) return false;
  if (!PERSON_ENTRYPOINTS.has(sample.entrypoint)) return false;
  return !sample.cwd || projectOf(sample.cwd) === sample.cwd;
}

function hasBridgeTool(record: Record<string, any>): boolean {
  const content = record.message?.content;
  return Array.isArray(content) && content.some((part: any) => part?.type === "tool_use" && typeof part.name === "string" && part.name.startsWith(BRIDGE_TOOL_PREFIX));
}

export async function listClaude(root = claudeProjects()): Promise<SourceListing> {
  let folders: string[];
  try {
    folders = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { root, found: false, chats: [], skipped: 0 };
  }
  const files: string[] = [];
  let skipped = 0;
  for (const folder of folders) {
    // Subagents' transcripts are in a session's own folder, one level down: only the folder's files are sessions.
    const names = (await readdir(join(root, folder)).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
    if (WORKTREE_FOLDER.test(folder)) skipped += names.length;
    else files.push(...names.map((name) => join(root, folder, name)));
  }
  const chats: SourceChat[] = [];
  await forEachLimit(files, 16, async (file) => {
    try {
      const info = await stat(file);
      const { head, tail } = await sampleLines(file, info.size, SAMPLE_BYTES, SAMPLE_BYTES);
      const sample = sampleClaude([...head, ...tail]);
      if (!isPersonsClaudeSession(sample) || !sample.cwd) {
        skipped++;
        return;
      }
      const id = basename(file, ".jsonl");
      const createdAt = sample.createdAt !== undefined && Number.isFinite(sample.createdAt) ? sample.createdAt : info.birthtimeMs;
      chats.push({ source: "claude", id, file, cwd: sample.cwd, title: sample.title, createdAt, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      skipped++;
    }
  });
  return { root, found: true, chats, skipped };
}

/** The fields of a record the conversion uses; images are dropped as they are read. */
interface Slim {
  uuid: string;
  parent?: string;
  type: string;
  subtype?: string;
  sidechain: boolean;
  meta: boolean;
  compactSummary: boolean;
  timestamp: number;
  messageId?: string;
  model?: string;
  content?: unknown;
}

function slimContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (part?.type === "image") return { type: "image" };
    if (part?.type === "tool_result" && Array.isArray(part.content)) return { ...part, content: part.content.map((inner: any) => (inner?.type === "image" ? { type: "image" } : inner)) };
    return part;
  });
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => (typeof part?.text === "string" ? part.text : part?.type === "image" ? IMAGE_PLACEHOLDER : "")).filter(Boolean).join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
}

export async function readClaude(chat: SourceChat): Promise<ImportedEntry[]> {
  const byUuid = new Map<string, Slim>();
  let leaf: Slim | undefined;
  let now = chat.createdAt;
  for await (const record of jsonRecords(chat.file)) {
    if (typeof record.uuid !== "string") continue;
    now = timeOf(record.timestamp, now);
    if (record.type === "assistant" && hasBridgeTool(record)) throw new NotAPersonsChat("a claude-bridge session");
    const slim: Slim = {
      uuid: record.uuid,
      parent: typeof record.parentUuid === "string" ? record.parentUuid : typeof record.logicalParentUuid === "string" ? record.logicalParentUuid : undefined,
      type: String(record.type),
      subtype: typeof record.subtype === "string" ? record.subtype : undefined,
      sidechain: record.isSidechain === true,
      meta: record.isMeta === true,
      compactSummary: record.isCompactSummary === true,
      timestamp: now,
    };
    if (record.type === "user" || record.type === "assistant") {
      slim.messageId = typeof record.message?.id === "string" ? record.message.id : undefined;
      slim.model = typeof record.message?.model === "string" ? record.message.model : undefined;
      slim.content = slimContent(record.message?.content);
      if (!slim.sidechain) leaf = slim;
    }
    byUuid.set(slim.uuid, slim);
  }

  // The active branch: from the last message back through its parents (a rewind leaves the abandoned turns in the file).
  const branch: Slim[] = [];
  const seen = new Set<string>();
  for (let cursor = leaf; cursor && !seen.has(cursor.uuid); cursor = cursor.parent ? byUuid.get(cursor.parent) : undefined) {
    seen.add(cursor.uuid);
    branch.push(cursor);
  }
  branch.reverse();

  let model = "unknown";
  let time = chat.createdAt;
  let answerId: string | undefined;
  const calls = new Map<string, ToolCall>();
  const builder = new EntryBuilder(() => assistantMessage("claude", "anthropic-messages", model, time));
  for (const record of branch) {
    time = record.timestamp;
    if (record.type === "user") {
      answerId = undefined;
      if (record.compactSummary) {
        builder.compaction(textOf(record.content), time);
        continue;
      }
      if (record.meta) continue;
      if (typeof record.content === "string") {
        builder.user(userMessage([{ text: record.content }], time));
        continue;
      }
      const parts: { text?: string; image?: true }[] = [];
      for (const part of Array.isArray(record.content) ? (record.content as any[]) : []) {
        if (part?.type === "tool_result") {
          const known = calls.get(part.tool_use_id);
          if (known) builder.result(toolResult(known, resultText(part.content), part.is_error === true, time));
        } else if (part?.type === "image") parts.push({ image: true });
        else if (typeof part?.text === "string") parts.push({ text: part.text });
      }
      builder.user(userMessage(parts, time));
    } else if (record.type === "assistant") {
      // Claude Code's placeholder for a failed request is not an answer.
      if (record.model === "<synthetic>") continue;
      if (record.model) model = record.model;
      const fresh = record.messageId !== answerId;
      answerId = record.messageId;
      let first = true;
      for (const part of Array.isArray(record.content) ? (record.content as any[]) : []) {
        const block =
          part?.type === "text" && typeof part.text === "string" && part.text
            ? { type: "text" as const, text: part.text }
            : part?.type === "thinking" && typeof part.thinking === "string"
              ? thinking(part.thinking)
              : part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string"
                ? mapToolCall(part.id, part.name, part.input && typeof part.input === "object" ? part.input : {})
                : undefined;
        if (!block) continue;
        if (block.type === "toolCall") calls.set(block.id, block);
        builder.block(block, fresh && first);
        builder.setModel(record.model);
        first = false;
      }
    }
  }
  return builder.finish();
}
