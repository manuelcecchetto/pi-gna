// Lists pi sessions grouped by project (groupSessions), and re-indexes one session file after its run settles
// (indexSettled). Summaries are cached by path + mtime + size, and the cache is kept on disk (persistSessionIndex) so
// a launch reads only the files that changed since the last one.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { ProjectGroup, SessionSummary } from "../shared/ipc";
import { groupSessions } from "../shared/session-list";
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
/** Where the cache is kept (userData/session-index.json) and its load from there. */
let persisted: { file: string; loaded: Promise<void> } | undefined;
let dirty = false;
let saving: Promise<void> = Promise.resolve();

/** Bump when SessionSummary or the way it is derived changes: an older file is then ignored. */
const CACHE_VERSION = 2;

interface CacheFile {
  version: number;
  entries: [string, { mtimeMs: number; size: number; summary: SessionSummary | null }][];
}

/** Keep the summary cache in `file`: loaded now, saved after each listing that changed it. */
export function persistSessionIndex(file: string): void {
  persisted = { file, loaded: loadCache(file) };
}

async function loadCache(file: string): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as CacheFile;
    if (saved.version !== CACHE_VERSION) return;
    for (const [path, entry] of saved.entries) cache.set(path, { mtimeMs: entry.mtimeMs, size: entry.size, summary: entry.summary ?? undefined });
  } catch {
    // First launch or a damaged file: whatever is missing is read from the session files. An entry only counts while
    // its file's mtime and size match.
  }
}

/** Saves run one after another, each a temp file renamed over the last. */
function saveCache(): void {
  if (!persisted || !dirty) return;
  dirty = false;
  const { file } = persisted;
  const data: CacheFile = { version: CACHE_VERSION, entries: [...cache].map(([path, entry]) => [path, { ...entry, summary: entry.summary ?? null }]) };
  saving = saving.then(async () => {
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(data));
      await rename(`${file}.tmp`, file);
    } catch (error) {
      log.warn("index", `save ${file}: ${(error as Error).message}`);
    }
  });
}

export async function listSessions(): Promise<ProjectGroup[]> {
  const root = sessionsDir();
  const started = Date.now();
  await persisted?.loaded;
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

  const summaries = await mapLimit(files, 16, indexSession);
  // Forget files that are gone, so the cache does not keep every deleted session.
  const present = new Set(files);
  for (const path of cache.keys()) {
    if (present.has(path)) continue;
    cache.delete(path);
    dirty = true;
  }
  saveCache();
  const result = groupSessions(summaries);

  const elapsed = Date.now() - started;
  if (elapsed > 500) log.info("index", `indexed ${files.length} sessions in ${elapsed} ms`);
  return result;
}

/**
 * A settled run's session file, re-indexed for the clients' lists (`session.indexed`, patchProjects): one stat, and a
 * read only when it changed. Null when it lists nothing; undefined outside the sessions folder, which no listing shows.
 */
export async function indexSettled(path: string): Promise<SessionSummary | null | undefined> {
  if (dirname(dirname(path)) !== sessionsDir()) return undefined;
  return (await indexSession(path)) ?? null;
}

/** One session file's row: undefined when it lists nothing (no user message or name) or cannot be read. */
async function indexSession(path: string): Promise<SessionSummary | undefined> {
  try {
    const info = await stat(path);
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;

    const file = await summarizeSessionFile(path, info.size);
    // Sessions without a user message or name are empty starts; hide them. A first message without text (an image) counts.
    const summary: SessionSummary | undefined = file && (file.title !== undefined || file.name) ? {
      path,
      id: file.header.id,
      cwd: file.header.cwd,
      title: file.name || file.title || "New chat",
      named: Boolean(file.name),
      createdAt: Date.parse(file.header.timestamp) || info.birthtimeMs,
      modifiedAt: info.mtimeMs,
    } : undefined;
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, summary });
    dirty = true;
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
