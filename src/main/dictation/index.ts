// Dictation's main side (docs/DESIGN.md, Dictation): installs the pinned transcribe.cpp library, Koffi addon and
// speech model when the setting turns on, runs the model in a utility process (dictation-worker.ts) from the first
// recording, and stops it after a while without any. The composer records and sends 16 kHz PCM; the text comes back.
import { join } from "node:path";
import type { DictationStatus } from "../../shared/dictation";
import { log } from "../log";
import type { Download } from "../autocomplete/assets";
import { type Fetch, fetchVerified, installArchive } from "../autocomplete/install";
import { type DictationRuntime, dictationRuntime, MODEL } from "./assets";

/** The worker stops after this long without a recording, giving its memory back. */
const IDLE_MS = 10 * 60_000;
/** The first load on a Mac compiles Metal shaders (about 9 s on an M4); later ones take a fraction of a second. */
const LOAD_MS = 120_000;
const TRANSCRIBE_MS = 60_000;

export type WorkerRequest = { id: number; pcm: Float32Array };
export type WorkerReply =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number; message: string };

/** The utility process, as main sees it (Electron's UtilityProcess has this shape). */
export interface DictationWorker {
  postMessage(message: WorkerRequest): void;
  on(event: "message", listener: (message: WorkerReply) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

/** What the worker needs to find, passed in its environment. */
export interface WorkerEnv {
  TRANSCRIBE_LIBRARY: string;
  PIGNA_KOFFI: string;
  PIGNA_DICTATION_MODEL: string;
}

export interface DictationDeps {
  /** userData/dictation. */
  dir: string;
  fetch: Fetch;
  fork(env: WorkerEnv): DictationWorker;
  onStatus(status: DictationStatus): void;
  /** Tests swap in their own runtime and model; the app uses the pins in assets.ts. null: none for this computer. */
  runtime?: DictationRuntime | null;
  model?: Download & { file: string };
}

interface Pending {
  resolve(text: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class Dictation {
  private status: DictationStatus = { phase: "off" };
  private enabled = false;
  private env: WorkerEnv | undefined;
  private installing: { abort: AbortController; done: Promise<void> } | undefined;
  private worker: Promise<DictationWorker> | undefined;
  private child: DictationWorker | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private next = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly runtime: DictationRuntime | undefined;
  private readonly model: Download & { file: string };

  constructor(private readonly deps: DictationDeps) {
    this.runtime = deps.runtime === undefined ? dictationRuntime() : (deps.runtime ?? undefined);
    this.model = deps.model ?? MODEL;
  }

  get(): DictationStatus {
    return this.status;
  }

  private set(status: Partial<DictationStatus>): void {
    this.status = { phase: this.status.phase, ...status };
    this.deps.onStatus(this.status);
  }

  /** Follows the setting: on installs what is missing, off stops the worker and any download. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      void this.install();
      return;
    }
    this.installing?.abort.abort();
    this.stop();
    this.set({ phase: "off", progress: undefined, error: undefined });
  }

  /** Tries the install, or the model's start, again after an error (Settings' Retry). */
  retry(): void {
    if (!this.enabled || this.status.phase !== "error") return;
    if (this.env) this.set({ phase: "ready", error: undefined });
    else void this.install();
  }

  private install(): Promise<void> {
    if (this.installing) return this.installing.done;
    const abort = new AbortController();
    const done = (async () => {
      const runtime = this.runtime;
      try {
        if (!runtime) throw new Error("Dictation has no speech model build for this computer.");
        const total = runtime.native.size + runtime.koffi.size + this.model.size;
        let received = 0;
        let shown = -1;
        const onBytes = (bytes: number) => {
          received += bytes;
          const progress = Math.min(0.99, Math.floor((received / total) * 100) / 100);
          if (progress > shown) this.set({ phase: "downloading", progress: (shown = progress), error: undefined });
        };
        const library = await installArchive(this.deps.fetch, runtime.native, join(this.deps.dir, "runtime"), runtime.native.library, onBytes, abort.signal);
        const koffi = await installArchive(this.deps.fetch, runtime.koffi, join(this.deps.dir, "runtime"), runtime.koffi.addon, onBytes, abort.signal);
        const model = join(this.deps.dir, "models", this.model.file);
        await fetchVerified(this.deps.fetch, this.model, model, onBytes, abort.signal);
        this.env = { TRANSCRIBE_LIBRARY: library, PIGNA_KOFFI: koffi, PIGNA_DICTATION_MODEL: model };
        if (this.enabled) this.set({ phase: "ready", progress: undefined });
      } catch (error) {
        if (abort.signal.aborted) return;
        log.error("dictation", `install failed: ${(error as Error).message}`);
        const message = runtime ? `Could not download the model: ${(error as Error).message}` : (error as Error).message;
        this.set({ phase: "error", progress: undefined, error: message });
      }
    })().finally(() => {
      if (this.installing?.abort === abort) this.installing = undefined;
    });
    this.installing = { abort, done };
    return done;
  }

  /** Loads the model ahead of a recording, so it is ready when the recording ends. */
  warm(): void {
    if (!this.enabled || !this.env) return;
    this.keepAlive();
    void this.start().catch(() => undefined);
  }

  private keepAlive(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
  }

  private start(): Promise<DictationWorker> {
    this.worker ??= this.launch().catch((error: Error) => {
      this.worker = undefined;
      throw error;
    });
    return this.worker;
  }

  private async launch(): Promise<DictationWorker> {
    const env = this.env;
    if (!env) throw new Error("Dictation is not installed.");
    this.set({ phase: "starting" });
    const child = this.deps.fork(env);
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the model did not load in time")), LOAD_MS);
      child.on("message", (reply) => {
        if (reply.type === "ready") resolve();
        else if (reply.type === "failed") reject(new Error(reply.message));
        else {
          const pending = this.pending.get(reply.id);
          if (!pending) return;
          this.pending.delete(reply.id);
          clearTimeout(pending.timer);
          if (reply.type === "result") pending.resolve(reply.text.trim());
          else pending.reject(new Error(reply.message));
        }
        if (reply.type === "ready" || reply.type === "failed") clearTimeout(timer);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the speech model stopped (exit code ${code})`));
        // Crashed or stopped: the next recording starts a new one.
        if (this.child !== child) return;
        this.child = undefined;
        this.worker = undefined;
        this.failPending(new Error(`the speech model stopped (exit code ${code})`));
      });
    });
    try {
      await ready;
    } catch (error) {
      child.kill();
      if (this.child === child) this.child = undefined;
      log.error("dictation", `start failed: ${(error as Error).message}`);
      if (this.enabled) this.set({ phase: "error", error: `The speech model would not start: ${(error as Error).message}` });
      throw error;
    }
    this.set({ phase: "ready" });
    return child;
  }

  /** The text spoken in `pcm` (16 kHz mono); throws when dictation is off, not ready or the model fails. */
  async transcribe(pcm: Float32Array): Promise<string> {
    if (!this.enabled || !this.env) throw new Error("Dictation is not ready yet.");
    this.keepAlive();
    const worker = await this.start();
    const id = ++this.next;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("transcribing took too long"));
      }, TRANSCRIBE_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, pcm });
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Stops the worker; the next recording starts it again. */
  stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.worker = undefined;
    this.failPending(new Error("dictation stopped"));
    child?.kill();
  }

  dispose(): void {
    this.enabled = false;
    this.installing?.abort.abort();
    this.stop();
  }
}
