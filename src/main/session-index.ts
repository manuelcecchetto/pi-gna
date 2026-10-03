// Lists pi sessions grouped by project (projectOf their cwd: a card's worktree counts as its project). Summaries
// are cached by path + mtime + size.
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { projectOf } from "../shared/board";
import type { ProjectGroup, SessionSummary } from "../shared/ipc";
import { log } from "./log";
import { summarizeSessionFile } from "./session-file";

export function sessionsDir(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: SessionSummary | undefined;
}

const cache = new Map<string, CacheEntry>();

export async function listSessions(): Promise<ProjectGroup[]> {
  const root = sessionsDir();
  const started = Date.now();
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  } catch {
    return [];
  }

  const files = (
    await Promise.all(
      dirs.map(async (dir) =>
        (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)),
      ),
    )
  ).flat();

  const summaries = await mapLimit(files, 16, summarize);
  const groups = new Map<string, ProjectGroup>();
  for (const summary of summaries) {
    if (!summary) continue;
    const cwd = projectOf(summary.cwd);
    const group = groups.get(cwd) ?? { cwd, modifiedAt: 0, sessions: [] };
    group.sessions.push(summary);
    group.modifiedAt = Math.max(group.modifiedAt, summary.modifiedAt);
    groups.set(cwd, group);
  }
  for (const group of groups.values()) group.sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const result = [...groups.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);

  const elapsed = Date.now() - started;
  if (elapsed > 500) log.info("index", `indexed ${files.length} sessions in ${elapsed} ms`);
  return result;
}

async function summarize(path: string): Promise<SessionSummary | undefined> {
  try {
    const info = await stat(path);
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;

    const file = await summarizeSessionFile(path, info.size);
    // Sessions without a user message or name are empty starts; hide them.
    const summary: SessionSummary | undefined = file && (file.title || file.name) ? {
      path,
      id: file.header.id,
      cwd: file.header.cwd,
      title: file.name || file.title || "New session",
      named: Boolean(file.name),
      createdAt: Date.parse(file.header.timestamp) || info.birthtimeMs,
      modifiedAt: info.mtimeMs,
    } : undefined;
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, summary });
    return summary;
  } catch (error) {
    log.warn("index", `skip ${path}: ${(error as Error).message}`);
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
