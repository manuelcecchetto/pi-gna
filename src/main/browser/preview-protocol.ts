// Serves local files on pigna-file://<token>/<path> for preview tabs. The token is the only capability: it maps to a root
// directory, and every request is confined under that root (decoded, then realpath). Design: docs/FILE_PREVIEW.md.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { session } from "electron";
import { PREVIEW_SCHEME, extensionOf, kindFor, parsePreviewUrl, servedAs, type PreviewKind } from "../../shared/preview";
import { PARTITION } from "./manager";

/** The bundled viewer is reserved under this prefix of every token. */
const VIEWER_PREFIX = "__viewer";

const VIEWER_CSP = [
  "default-src 'none'",
  // pdf.js decodes JPEG 2000, JBIG2 and ICC colors with bundled WebAssembly; this allows compiling wasm, not JS eval.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", svg: "image/svg+xml",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", xhtml: "application/xhtml+xml",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac", opus: "audio/ogg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
};

/** Content type by extension; unknown types are an opaque download-ish stream, never sniffed into something executable. */
export function contentTypeFor(path: string): string {
  return TYPES[extensionOf(path)] ?? "application/octet-stream";
}

export type ByteRange = { start: number; end: number };

/** Parse a `Range` header for a file of `size` bytes: a range, undefined (no or multi-range header: serve all), or "invalid" (416). */
export function parseRange(header: string | null, size: number): ByteRange | undefined | "invalid" {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return /^bytes=.*,/.test(header.trim()) ? undefined : "invalid";
  const [, from = "", to = ""] = match;
  if (!from && !to) return "invalid";
  if (!from) {
    const length = Number(to);
    if (length === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  const end = to ? Math.min(Number(to), size - 1) : size - 1;
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/**
 * Join a decoded relative path under `root` lexically. Undefined for anything that could leave it: NUL, backslashes,
 * `..` segments (also ones smuggled in as %2f), or a dotfile segment that is not `allowed` (the opened file itself).
 */
export function confine(root: string, relative: string, allowed: ReadonlySet<string> = new Set()): string | undefined {
  if (relative.includes("\0") || relative.includes("\\")) return undefined;
  const segments = relative.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) return undefined;
  const clean = segments.filter((segment) => segment !== ".");
  if (!allowed.has(clean.join("/")) && clean.some((segment) => segment.startsWith("."))) return undefined;
  const file = resolve(root, ...clean);
  return file === root || file.startsWith(root + sep) ? file : undefined;
}

interface Entry {
  root: string;
  /** Relative paths of dotfiles the user opened explicitly; other dotfiles stay unreachable. */
  allowed: Set<string>;
}

/** Tokens for preview roots, in memory only. One token per root so relative links between its files stay on one origin. */
export class PreviewRegistry {
  private readonly entries = new Map<string, Entry>();

  /** Token for `root` (an absolute directory, realpathed by the caller); `open` is the relative path the user opened. */
  mint(root: string, open?: string): string {
    let token = [...this.entries].find(([, entry]) => entry.root === root)?.[0];
    if (!token) {
      token = randomBytes(16).toString("hex");
      this.entries.set(token, { root, allowed: new Set() });
    }
    if (open) this.entries.get(token)?.allowed.add(open.split("/").filter(Boolean).join("/"));
    return token;
  }

  revoke(token: string): boolean {
    return this.entries.delete(token);
  }

  get(token: string): Entry | undefined {
    return this.entries.get(token);
  }

  /** Real path behind a preview URL, for Reveal in Finder and Open with default app. */
  resolve(url: string): { path: string; root: string } | undefined {
    const parsed = parsePreviewUrl(url);
    const entry = parsed && this.entries.get(parsed.token);
    if (!parsed || !entry) return undefined;
    const path = confine(entry.root, parsed.relative, entry.allowed);
    return path ? { path, root: entry.root } : undefined;
  }
}

export const previews = new PreviewRegistry();

const notFound = (status = 404): Response => new Response("not found", { status, headers: { "cache-control": "no-store" } });

function baseHeaders(type: string): Headers {
  return new Headers({ "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
}

async function serveViewer(viewerDir: string, relative: string, head: boolean): Promise<Response> {
  const asset = relative.slice(VIEWER_PREFIX.length + 1) || "index.html";
  const file = confine(viewerDir, asset);
  if (!file) return notFound();
  try {
    let body: string | Buffer = await readFile(file);
    if (asset === "index.html") body = body.toString("utf8").replaceAll('="./', `="/${VIEWER_PREFIX}/`);
    const headers = baseHeaders(asset === "index.html" ? "text/html; charset=utf-8" : contentTypeFor(asset));
    headers.set("content-security-policy", VIEWER_CSP);
    return new Response(head ? null : body, { headers });
  } catch {
    return new Response("viewer not built", { status: 500, headers: { "cache-control": "no-store" } });
  }
}

/** Answer one pigna-file request. `viewerDir` is the built viewer bundle (out/preview). */
export async function handlePreview(registry: PreviewRegistry, viewerDir: string, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(405);
  const head = request.method === "HEAD";
  const parsed = parsePreviewUrl(request.url);
  const entry = parsed && registry.get(parsed.token);
  if (!parsed || !entry) return notFound();
  if (parsed.relative === VIEWER_PREFIX || parsed.relative.startsWith(`${VIEWER_PREFIX}/`)) return serveViewer(viewerDir, parsed.relative, head);
  try {
    const target = confine(entry.root, parsed.relative, entry.allowed);
    if (!target) return notFound();
    // The symlink check: the real file must still live under the (realpathed) root.
    const file = await realpath(target);
    if (!file.startsWith(entry.root + sep)) return notFound();
    const info = await stat(file);
    if (!info.isFile()) return notFound();
    const kind: PreviewKind = kindFor(file);
    const rendered = parsed.view !== "raw" && parsed.view !== "source";
    // A navigation to a viewer kind gets the viewer page; the viewer itself fetches the bytes with ?raw=1. A subresource
    // of a raw HTML page (its stylesheet, script, image) names no text/html in Accept and must get the file's bytes.
    const accept = request.headers.get("accept");
    const subresource = accept !== null && !accept.includes("text/html");
    if (!parsed.raw && !subresource && servedAs(kind, rendered ? "rendered" : "raw") === "viewer") return serveViewer(viewerDir, `${VIEWER_PREFIX}/index.html`, head);
    return serveBytes(file, info.size, contentTypeFor(file), request.headers.get("range"), head);
  } catch {
    return notFound();
  }
}

function serveBytes(file: string, size: number, type: string, rangeHeader: string | null, head: boolean): Response {
  const headers = baseHeaders(type);
  headers.set("accept-ranges", "bytes");
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
  const status = range ? 206 : 200;
  if (head || length === 0) return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status, headers });
}

/** Register the scheme handler on the browser partition only, never on the default session. */
export function servePreview(viewerDir: string, registry: PreviewRegistry = previews): void {
  session.fromPartition(PARTITION).protocol.handle(PREVIEW_SCHEME, (request) => handlePreview(registry, viewerDir, request));
}
