// Fetches and unpacks what composer autocomplete runs (assets.ts) into userData/autocomplete. A file is used only
// after its size and SHA-256 match the pin; a `.ok` marker beside it records that, so a start does not hash 380 MB
// again. Downloads go to a `.part` file first, so a quit mid-download leaves nothing that looks finished.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Download, ServerBuild } from "./assets";

export type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

/** Downloads `download` to `path` unless it is there and verified; `onBytes` gets each chunk's length. */
export async function fetchVerified(fetch: Fetch, download: Download, path: string, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  const ok = `${path}.ok`;
  if (existsSync(ok) && (await stat(path).catch(() => undefined))?.size === download.size) {
    onBytes(download.size);
    return;
  }
  await mkdir(join(path, ".."), { recursive: true });
  const part = `${path}.part`;
  const response = await fetch(download.url, { signal });
  if (!response.ok || !response.body) throw new Error(`the download answered ${response.status} ${response.statusText}`);
  const hash = createHash("sha256");
  let received = 0;
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        hash.update(chunk);
        received += chunk.length;
        onBytes(chunk.length);
        yield chunk;
      }
    },
    createWriteStream(part),
    { signal },
  );
  if (received !== download.size) throw new Error(`the download stopped at ${received} of ${download.size} bytes`);
  if (hash.digest("hex") !== download.sha256) {
    await rm(part, { force: true });
    throw new Error("the download does not match its checksum");
  }
  await rename(part, path);
  await writeFile(ok, download.sha256);
}

/** The system's own tar: bsdtar on macOS and Windows 10+ (which also reads zip), GNU tar on Linux. */
export function tarCommand(platform: string = process.platform): string {
  if (platform === "win32") return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return platform === "darwin" ? "/usr/bin/tar" : "tar";
}

const run = (file: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile(file, args, { windowsHide: true }, (error, _out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve())));

/** The llama-server executable under `dir`, wherever the archive put it. */
export async function findServer(dir: string, platform: string = process.platform): Promise<string | undefined> {
  const name = platform === "win32" ? "llama-server.exe" : "llama-server";
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isFile() && entry.name === name) return join(dir, entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findServer(join(dir, entry.name), platform);
    if (found) return found;
  }
  return undefined;
}

/** Downloads and unpacks one server build under `root`; returns its executable. */
export async function installServer(fetch: Fetch, build: ServerBuild, root: string, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  const dir = join(root, build.id);
  const done = join(dir, ".unpacked");
  if (existsSync(done)) {
    const found = await findServer(dir);
    if (found) {
      onBytes(build.size);
      return found;
    }
  }
  const archive = join(root, `${build.id}${build.url.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
  await fetchVerified(fetch, build, archive, onBytes, signal);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await run(tarCommand(), ["-xf", archive, "-C", dir]);
  const found = await findServer(dir);
  if (!found) throw new Error(`no llama-server in ${build.id}`);
  await writeFile(done, build.sha256);
  await rm(archive, { force: true });
  await rm(`${archive}.ok`, { force: true });
  return found;
}
