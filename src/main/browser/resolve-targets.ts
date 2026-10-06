// Which chat file links exist: link targets -> absolute file path or null, with a short-lived cache so a
// streaming answer's repeated renders stay cheap. Also the bytes of the images an answer embeds (`![alt](path)`).
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import { extensionOf, kindFor, parseLinkTarget } from "../../shared/preview";

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

/** An embedded image larger than this stays a file link: the bytes travel to the renderer as base64. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", svg: "image/svg+xml",
};

/**
 * The image a chat answer embeds with `![alt](target)`, resolved like a file link; null when the target is missing,
 * not an image by extension, or too large. An `<img>` never runs an SVG's scripts.
 */
export async function readPreviewImage(cwd: string, target: string, roots?: string[]): Promise<{ mimeType: string; data: string } | null> {
  const found = await resolveOne(cwd, target);
  const path = roots ? await within(found, roots) : found;
  const mimeType = path && kindFor(path) === "image" ? IMAGE_TYPES[extensionOf(path)] : undefined;
  if (!path || !mimeType) return null;
  try {
    if ((await stat(path)).size > MAX_IMAGE_BYTES) return null;
    return { mimeType, data: (await readFile(path)).toString("base64") };
  } catch {
    return null;
  }
}

/**
 * `path` when it lies inside one of `roots`, symlinks followed on both sides; otherwise null. A phone opens only the
 * files of its chat's folders: it never reads files by path (docs/REMOTE.md, fs.describePaths).
 */
export async function within(path: string | null, roots: string[]): Promise<string | null> {
  if (!path) return null;
  const real = await realpath(path).catch(() => null);
  if (!real) return null;
  const bases = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return bases.some((base) => base && (real === base || real.startsWith(base.endsWith(sep) ? base : base + sep))) ? path : null;
}

/** Targets resolve against the chat's cwd (its worktree for worktree chats). */
export function resolvePreviewTargets(cwd: string, targets: string[]): Promise<(string | null)[]> {
  return Promise.all(targets.slice(0, MAX_TARGETS).map((target) => resolveOne(cwd, target)));
}
