// Keeps FileUsageFacts for every session file under the usage roots, cached on disk and brought up to date incrementally.
// Extraction runs in worker threads (usage-worker.ts); this module only walks, stats, compares and saves the cache.
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { type FileUsageFacts, SOURCE_ROOTS, type SourceRoot, USAGE_FACTS_VERSION } from "../shared/usage";
import { classifySession } from "../shared/usage-classify";
import { log } from "./log";
import type { ExtractTarget } from "./usage-extract";
import type { ExtractReply, ExtractRequest } from "./usage-worker";

export type Extract = (target: ExtractTarget, previous?: FileUsageFacts) => Promise<FileUsageFacts | undefined>;

export interface Extractor {
  extract: Extract;
  close(): Promise<void>;
}

export interface IndexProgress {
  done: number;
  total: number;
  /** Bytes of the files done so far, unchanged ones included. */
  bytes: number;
}

export interface UsageIndexOptions {
  roots: Record<SourceRoot, string>;
  /** userData/usage-index.json. */
  file: string;
  /** Opened per run and closed when the run settles. */
  openExtractor: () => Extractor;
  concurrency: number;
}

interface CacheEntry {
  /** A hash of the file's first `headBytes` bytes: a grown file resumes only while that prefix is unchanged. */
  head: string;
  headBytes: number;
  facts: FileUsageFacts;
}

interface CacheFile {
  version: number;
  entries: [string, CacheEntry][];
}

interface Found {
  root: SourceRoot;
  path: string;
  size: number;
  mtimeMs: number;
}

const HEAD_BYTES = 4096;

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export class UsageIndex {
  private readonly entries = new Map<string, CacheEntry>();
  private loaded: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;

  constructor(private readonly options: UsageIndexOptions) {}

  ensureIndexed(onProgress?: (progress: IndexProgress) => void): Promise<void> {
    return this.enqueue(() => this.scanAll(onProgress));
  }

  refreshFile(path: string): Promise<void> {
    return this.enqueue(() => this.refreshOne(path));
  }

  allFacts(): FileUsageFacts[] {
    // Two files with one session id hold the same entries (a copy or a fork): the longer one counts, once.
    const best = new Map<string, FileUsageFacts>();
    for (const { facts } of this.entries.values()) {
      const held = best.get(facts.session.id);
      if (!held || facts.consumedBytes > held.consumedBytes || (facts.consumedBytes === held.consumedBytes && facts.mtimeMs > held.mtimeMs)) {
        best.set(facts.session.id, facts);
      }
    }
    return [...best.values()];
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.load()).then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private load(): Promise<void> {
    this.loaded ??= this.readCache();
    return this.loaded;
  }

  private async readCache(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.options.file, "utf8");
    } catch {
      return;
    }
    let saved: unknown;
    try {
      saved = JSON.parse(text);
    } catch {
      saved = undefined;
    }
    if (!isCacheFile(saved)) {
      log.warn("usage", "usage index is damaged or from another version; rebuilding");
      return;
    }
    for (const [path, entry] of saved.entries) this.entries.set(path, entry);
  }

  private async scanAll(onProgress?: (progress: IndexProgress) => void): Promise<void> {
    const found = (await Promise.all(SOURCE_ROOTS.map((root) => findFiles(root, this.options.roots[root])))).flat();
    const present = new Set(found.map((file) => file.path));
    for (const path of [...this.entries.keys()]) {
      if (present.has(path)) continue;
      this.entries.delete(path);
      this.dirty = true;
    }

    let done = 0;
    let bytes = 0;
    const finish = (file: Found) => {
      done++;
      bytes += file.size;
      onProgress?.({ done, total: found.length, bytes });
    };
    const stale: Found[] = [];
    for (const file of found) {
      if (this.isCurrent(file)) finish(file);
      else stale.push(file);
    }

    const extractor = this.options.openExtractor();
    try {
      await forEachLimit(stale, this.options.concurrency, async (file) => {
        await this.extractFile(file, extractor);
        finish(file);
      });
    } finally {
      await extractor.close();
    }
    this.classifySubagents();
    await this.save();
  }

  private async refreshOne(path: string): Promise<void> {
    const root = SOURCE_ROOTS.find((candidate) => path.startsWith(this.options.roots[candidate] + sep));
    if (!root) return;
    const info = await statFile(path);
    if (!info) {
      if (this.entries.delete(path)) this.dirty = true;
    } else {
      const file: Found = { root, path, ...info };
      if (!this.isCurrent(file)) {
        const extractor = this.options.openExtractor();
        try {
          await this.extractFile(file, extractor);
        } finally {
          await extractor.close();
        }
      }
    }
    this.classifySubagents();
    await this.save();
  }

  private isCurrent(file: Found): boolean {
    const cached = this.entries.get(file.path);
    return cached !== undefined && cached.facts.size === file.size && cached.facts.mtimeMs === file.mtimeMs;
  }

  private async extractFile(file: Found, extractor: Extractor): Promise<void> {
    const cached = this.entries.get(file.path);
    try {
      const headBytes = Math.min(HEAD_BYTES, file.size);
      const head = await headOf(file.path, headBytes);
      const grown = cached !== undefined && file.size > cached.facts.size;
      const previous = grown && (await headOf(file.path, cached.headBytes)) === cached.head ? cached.facts : undefined;
      const facts = await extractor.extract({ root: file.root, path: file.path }, previous);
      if (facts) this.entries.set(file.path, { head, headBytes, facts });
      else this.entries.delete(file.path);
    } catch (error) {
      this.entries.delete(file.path);
      log.warn("usage", `skip ${file.path}: ${(error as Error).message}`);
    }
    this.dirty = true;
  }

  /** A subagent's `pigna` flag is its parent's, which only the parent's facts know (classifySession takes it as an argument). */
  private classifySubagents(): void {
    for (const { facts } of this.entries.values()) {
      const { session } = facts;
      const marker = session.path.lastIndexOf(`${sep}tasks${sep}`);
      if (!session.parentId || marker < 0) continue;
      const parent = this.entries.get(`${session.path.slice(0, marker)}.jsonl`)?.facts;
      if (!parent) continue;
      const placed = classifySession(
        { root: session.root, path: session.path, cwd: session.cwd, parentId: session.parentId, markers: facts.markers },
        parent.session.pigna,
      );
      if (placed.isPigna === session.pigna && placed.surface === session.surface && placed.project === session.project && placed.card === session.card) continue;
      session.pigna = placed.isPigna;
      session.surface = placed.surface;
      session.project = placed.project;
      session.card = placed.card;
      this.dirty = true;
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const data: CacheFile = { version: USAGE_FACTS_VERSION, entries: [...this.entries] };
    const { file } = this.options;
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(data));
      await rename(`${file}.tmp`, file);
    } catch (error) {
      this.dirty = true;
      log.warn("usage", `save ${file}: ${(error as Error).message}`);
    }
  }
}

function isCacheFile(value: unknown): value is CacheFile {
  const file = value as CacheFile | undefined;
  return (
    file?.version === USAGE_FACTS_VERSION &&
    Array.isArray(file.entries) &&
    file.entries.every(
      ([path, entry]) => typeof path === "string" && typeof entry?.head === "string" && entry.facts?.version === USAGE_FACTS_VERSION,
    )
  );
}

async function findFiles(root: SourceRoot, dir: string): Promise<Found[]> {
  const found = await Promise.all((await walk(dir)).map(async (path) => {
    const info = await statFile(path);
    return info ? [{ root, path, ...info }] : [];
  }));
  return found.flat();
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

async function headOf(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return createHash("sha1").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T);
    }),
  );
}

/** A pool of `size` worker threads, one request in flight per worker; a worker that dies fails its request and is respawned. */
export function openWorkerExtractor(workerFile: string, size: number): Extractor {
  const workers: (Worker | undefined)[] = new Array<Worker | undefined>(size).fill(undefined);
  const free = Array.from({ length: size }, (_, slot) => slot);
  const waiting: ((slot: number) => void)[] = [];
  const waits = new Map<number, { slot: number; resolve: (facts: FileUsageFacts | undefined) => void; reject: (error: Error) => void }>();
  let seq = 0;

  const drain = () => {
    while (free.length > 0 && waiting.length > 0) waiting.shift()?.(free.pop() as number);
  };
  const acquire = () =>
    new Promise<number>((resolve) => {
      waiting.push(resolve);
      drain();
    });
  const release = (slot: number) => {
    free.push(slot);
    drain();
  };

  const failSlot = (slot: number, worker: Worker, error: Error) => {
    if (workers[slot] === worker) workers[slot] = undefined;
    for (const [id, wait] of waits) {
      if (wait.slot !== slot) continue;
      waits.delete(id);
      wait.reject(error);
    }
  };

  const spawn = (slot: number): Worker => {
    const worker = new Worker(workerFile);
    worker.on("message", (reply: ExtractReply) => {
      const wait = waits.get(reply.id);
      if (!wait) return;
      waits.delete(reply.id);
      if (reply.error !== undefined) wait.reject(new Error(reply.error));
      else wait.resolve(reply.facts);
    });
    worker.on("error", (error) => failSlot(slot, worker, error));
    worker.on("exit", (code) => failSlot(slot, worker, new Error(`usage worker exited with code ${code}`)));
    workers[slot] = worker;
    return worker;
  };

  return {
    async extract(target, previous) {
      const slot = await acquire();
      try {
        const worker = workers[slot] ?? spawn(slot);
        const id = ++seq;
        const reply = new Promise<FileUsageFacts | undefined>((resolve, reject) => waits.set(id, { slot, resolve, reject }));
        const request: ExtractRequest = { id, target, previous };
        worker.postMessage(request);
        return await reply;
      } finally {
        release(slot);
      }
    },
    async close() {
      await Promise.all(workers.map((worker) => worker?.terminate()));
      workers.fill(undefined);
    },
  };
}
