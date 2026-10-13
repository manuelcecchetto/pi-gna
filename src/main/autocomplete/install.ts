// Fetches and unpacks what composer autocomplete and dictation run (their assets.ts) into userData. A file is used only
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

/** The first file called `name` under `dir`, wherever the archive put it. */
export async function findFile(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isFile() && entry.name === name) return join(dir, entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(dir, entry.name), name);
    if (found) return found;
  }
  return undefined;
}

/** An archive to unpack: its download and the folder name it unpacks into. */
export interface Archive extends Download {
  id: string;
}

/**
 * Downloads and unpacks `archive` under `root` unless an earlier run did; returns the file `name` inside it: a bare
 * name is searched for, a path with a / is taken as is. A `.unpacked` marker records a finished unpack, and the
 * archive itself is deleted once unpacked.
 */
export async function installArchive(fetch: Fetch, archive: Archive, root: string, name: string, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  const dir = join(root, archive.id);
  const done = join(dir, ".unpacked");
  const find = () => (name.includes("/") ? Promise.resolve(existsSync(join(dir, name)) ? join(dir, name) : undefined) : findFile(dir, name));
  if (existsSync(done)) {
    const found = await find();
    if (found) {
      onBytes(archive.size);
      return found;
    }
  }
  const file = join(root, `${archive.id}${archive.url.endsWith(".zip") ? ".zip" : archive.url.endsWith(".tgz") ? ".tgz" : ".tar.gz"}`);
  await fetchVerified(fetch, archive, file, onBytes, signal);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await run(tarCommand(), ["-xf", file, "-C", dir]);
  const found = await find();
  if (!found) throw new Error(`no ${name} in ${archive.id}`);
  await writeFile(done, archive.sha256);
  await rm(file, { force: true });
  await rm(`${file}.ok`, { force: true });
  return found;
}

/** Downloads and unpacks one server build under `root`; returns its executable. */
export const installServer = (fetch: Fetch, build: ServerBuild, root: string, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<string> =>
  installArchive(fetch, build, root, process.platform === "win32" ? "llama-server.exe" : "llama-server", onBytes, signal);
