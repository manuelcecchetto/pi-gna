// Which chat file links exist: link targets -> absolute file path or null, with a short-lived cache so a
// streaming answer's repeated renders stay cheap.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { parseLinkTarget } from "../../shared/preview";

const TTL_MS = 5000;
const MAX_ENTRIES = 500;
export const MAX_TARGETS = 200;

const cache = new Map<string, { at: number; path: string | null }>();

async function resolveOne(cwd: string, target: string): Promise<string | null> {
  const key = `${cwd}\0${target}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.path;
  let path: string | null = null;
  const parsed = parseLinkTarget(target, cwd, homedir());
  if (parsed) {
    try {
      if ((await stat(parsed.path)).isFile()) path = parsed.path;
    } catch {
      // missing or unreadable: not a link
    }
  }
  if (cache.size >= MAX_ENTRIES) for (const [k, v] of cache) if (now - v.at >= TTL_MS || cache.size >= MAX_ENTRIES) cache.delete(k);
  cache.set(key, { at: now, path });
  return path;
}

/** Targets resolve against the chat's cwd (its worktree for worktree chats). */
export function resolvePreviewTargets(cwd: string, targets: string[]): Promise<(string | null)[]> {
  return Promise.all(targets.slice(0, MAX_TARGETS).map((target) => resolveOne(cwd, target)));
}
