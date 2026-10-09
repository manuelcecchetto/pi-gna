// Project file list for @ mentions, via `rg --files` (respects .gitignore). Kept until the project's files change: a
// recursive watcher drops the list when a file appears, goes or is renamed, or an ignore file changes, so @ mentions in
// a big repository run rg again only after something changed. Where a recursive watch is not native (on Linux, Node
// walks the whole tree to set one up), a list lasts 15 s instead.
import { spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { basename } from "node:path";
import { JsonlSplitter } from "./jsonl";
import { log } from "./log";

const MAX_FILES = 50_000;
const TTL_MS = 15_000;
const WATCHED = process.platform === "darwin" || process.platform === "win32";
/** Projects whose lists (and watchers) are kept; the least recently used goes first. */
const MAX_PROJECTS = 8;
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".rgignore"]);
type Entry = { at: number; files: Promise<string[]>; watcher?: FSWatcher };
const cache = new Map<string, Entry>();

export function listFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && (hit.watcher || Date.now() - hit.at < TTL_MS)) {
    cache.delete(cwd);
    cache.set(cwd, hit);
    return hit.files;
  }
  drop(cwd);
  // Watched before rg runs, so a change while it runs drops the list it returns.
  const watcher = WATCHED ? watchProject(cwd) : undefined;
  const entry: Entry = {
    at: Date.now(),
    // When rg fails (say, it is not installed), the empty list expires instead of waiting for a change.
    files: run(cwd).then((files) => {
      if (files) return files;
      entry.watcher?.close();
      entry.watcher = undefined;
      return [];
    }),
    watcher,
  };
  cache.set(cwd, entry);
  for (const old of cache.keys()) {
    if (cache.size <= MAX_PROJECTS) break;
    drop(old);
  }
  return entry.files;
}

function drop(cwd: string): void {
  cache.get(cwd)?.watcher?.close();
  cache.delete(cwd);
}

/** Drops the project's list when its file list may have changed; undefined when the folder cannot be watched (the list then expires). */
function watchProject(cwd: string): FSWatcher | undefined {
  try {
    const watcher = watch(cwd, { recursive: true }, (event, name) => {
      const file = name?.toString().replaceAll("\\", "/") ?? "";
      if (file === ".git" || file.startsWith(".git/")) return;
      // A content change is "change"; a file that appears, goes or is renamed is "rename" (also an edit of a file
      // made moments before, which only drops a list early).
      if (event !== "rename" && !IGNORE_FILES.has(basename(file))) return;
      if (cache.get(cwd)?.watcher === watcher) drop(cwd);
    });
    watcher.on("error", () => {
      if (cache.get(cwd)?.watcher === watcher) drop(cwd);
      watcher.close();
    });
    return watcher;
  } catch (error) {
    log.warn("files", `cannot watch ${cwd}: ${(error as Error).message}`);
    return undefined;
  }
}

function run(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const files: string[] = [];
    const splitter = new JsonlSplitter();
    const child = spawn("rg", ["--files", "--hidden", "--glob", "!.git"], { cwd });
    child.stdout.on("data", (chunk: Buffer) => {
      files.push(...splitter.push(chunk));
      if (files.length >= MAX_FILES) child.kill();
    });
    child.on("error", (error) => {
      log.warn("files", `rg failed: ${error.message}`);
      resolve(null);
    });
    child.on("close", () => resolve(files.slice(0, MAX_FILES)));
  });
}
