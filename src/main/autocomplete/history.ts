// The messages a person typed in a project's earlier chats, read from pi's session files (never sent anywhere):
// composer autocomplete shows the model the few that share the most words with the draft. Per project, the newest
// session files are read line by line, and a file is read again only when its size or mtime changed.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isTypedPrompt } from "../../shared/autocomplete";
import { projectOf } from "../../shared/board";
import { sessionFolder } from "../chat-import/session";

/** The newest session files read per folder, and the most messages kept per project. */
const FILES = 200;
const PROMPTS = 3000;
/** How long a project's list is used before its folders are looked at again. */
const FRESH_MS = 60_000;

interface FileEntry {
  mtimeMs: number;
  size: number;
  prompts: string[];
}

/** The text a session line's user message carries, or undefined for any other line. */
export function userText(line: string): string | undefined {
  // Most lines are tool output; only parse the ones that can be a user message.
  if (!line.includes('"role":"user"')) return undefined;
  try {
    const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    return content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  } catch {
    return undefined;
  }
}

async function readPrompts(path: string): Promise<string[]> {
  const prompts: string[] = [];
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const text = userText(line)?.trim();
    if (text && isTypedPrompt(text)) prompts.push(text);
  }
  return prompts;
}

export class PromptHistory {
  private readonly files = new Map<string, FileEntry>();
  private readonly projects = new Map<string, { at: number; prompts: Promise<string[]> }>();

  constructor(private readonly sessionsDir: () => string) {}

  /** The project's typed messages, newest first, without repeats. */
  prompts(cwd: string): Promise<string[]> {
    const project = projectOf(cwd);
    const cached = this.projects.get(project);
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.prompts;
    const prompts = this.load([...new Set([project, cwd])]).catch(() => []);
    this.projects.set(project, { at: Date.now(), prompts });
    return prompts;
  }

  private async load(cwds: string[]): Promise<string[]> {
    const files: { path: string; mtimeMs: number; size: number }[] = [];
    for (const cwd of cwds) {
      const dir = sessionFolder(this.sessionsDir(), cwd);
      const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
      for (const name of names) {
        const path = join(dir, name);
        const info = await stat(path).catch(() => undefined);
        if (info) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const file of files.slice(0, FILES)) {
      let entry = this.files.get(file.path);
      if (!entry || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) {
        entry = { mtimeMs: file.mtimeMs, size: file.size, prompts: await readPrompts(file.path).catch(() => []) };
        this.files.set(file.path, entry);
      }
      for (const prompt of [...entry.prompts].reverse()) {
        if (seen.has(prompt)) continue;
        seen.add(prompt);
        out.push(prompt);
        if (out.length >= PROMPTS) return out;
      }
    }
    return out;
  }
}
