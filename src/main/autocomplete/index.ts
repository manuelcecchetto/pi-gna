// Composer autocomplete's main side (docs/DESIGN.md, Composer autocomplete): installs the pinned llama.cpp server and
// typeahead model when the setting turns on, runs the server on 127.0.0.1 behind a random API key while the composer
// asks for suggestions, and stops it after a while without any. One suggestion in flight per client: a new keystroke
// aborts the last one.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { type AutocompleteStatus, buildPrompt, cleanSuggestion, pickExamples, type SuggestRequest, wantsSuggestion } from "../../shared/autocomplete";
import { log } from "../log";
import { type Download, MODEL, type ServerBuild, serverBuilds } from "./assets";
import { type Fetch, fetchVerified, installServer } from "./install";
import { PromptHistory } from "./history";

/** The server stops after this long without a suggestion, giving its memory back. */
const IDLE_MS = 10 * 60_000;
const START_MS = 60_000;
const SUGGEST_MS = 3000;

export interface AutocompleteDeps {
  /** userData/autocomplete. */
  dir: string;
  sessionsDir: () => string;
  fetch: Fetch;
  onStatus(status: AutocompleteStatus): void;
  /** Tests swap in their own builds and model; the app uses the pins in assets.ts. */
  builds?: readonly ServerBuild[];
  model?: Download & { file: string };
}

interface Server {
  child: ChildProcess;
  url: string;
  key: string;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });

export class Autocomplete {
  private status: AutocompleteStatus = { phase: "off" };
  private enabled = false;
  /** The verified executable of each build tried, and the builds that would not start here. */
  private executable: { build: ServerBuild; path: string } | undefined;
  private readonly failed = new Set<string>();
  private installing: { abort: AbortController; done: Promise<void> } | undefined;
  private server: Promise<Server> | undefined;
  private child: ChildProcess | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly inflight = new Map<string, AbortController>();
  private readonly history: PromptHistory;
  private readonly builds: readonly ServerBuild[];
  private readonly model: Download & { file: string };

  constructor(private readonly deps: AutocompleteDeps) {
    this.history = new PromptHistory(deps.sessionsDir);
    this.builds = deps.builds ?? serverBuilds();
    this.model = deps.model ?? MODEL;
  }

  get(): AutocompleteStatus {
    return this.status;
  }

  private set(status: Partial<AutocompleteStatus>): void {
    this.status = { phase: this.status.phase, ...status };
    this.deps.onStatus(this.status);
  }

  /** Follows the setting: on installs what is missing, off stops the server and any download. */
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

  /** Tries the install again after an error (Settings' Retry). */
  retry(): void {
    if (!this.enabled || this.status.phase !== "error") return;
    this.failed.clear();
    void this.install();
  }

  private install(): Promise<void> {
    if (this.installing) return this.installing.done;
    const abort = new AbortController();
    const done = (async () => {
      const build = this.builds.find((candidate) => !this.failed.has(candidate.id));
      try {
        if (!build) throw new Error("Autocomplete has no local model build for this computer.");
        const total = build.size + this.model.size;
        let received = 0;
        let shown = -1;
        const onBytes = (bytes: number) => {
          received += bytes;
          const progress = Math.min(0.99, Math.floor((received / total) * 100) / 100);
          if (progress > shown) this.set({ phase: "downloading", progress: (shown = progress), error: undefined });
        };
        const path = await installServer(this.deps.fetch, build, join(this.deps.dir, "server"), onBytes, abort.signal);
        await fetchVerified(this.deps.fetch, this.model, this.modelPath(), onBytes, abort.signal);
        this.executable = { build, path };
        if (this.enabled) this.set({ phase: "ready", progress: undefined });
      } catch (error) {
        if (abort.signal.aborted) return;
        log.error("autocomplete", `install failed: ${(error as Error).message}`);
        this.set({ phase: "error", progress: undefined, error: `Could not download the model: ${(error as Error).message}` });
      }
    })().finally(() => {
      if (this.installing?.abort === abort) this.installing = undefined;
    });
    this.installing = { abort, done };
    return done;
  }

  private modelPath(): string {
    return join(this.deps.dir, "models", this.model.file);
  }

  private start(): Promise<Server> {
    this.server ??= this.launch().catch((error: Error) => {
      this.server = undefined;
      throw error;
    });
    return this.server;
  }

  private async launch(): Promise<Server> {
    const executable = this.executable;
    if (!executable) throw new Error("not installed");
    this.set({ phase: "starting" });
    const port = await freePort();
    const key = randomBytes(24).toString("hex");
    const args = ["-m", this.modelPath(), "--host", "127.0.0.1", "--port", String(port), "--api-key", key, "-c", "4096", "-np", "1", "-ngl", "99", "--cache-reuse", "256", "--no-webui"];
    const child = spawn(executable.path, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    const url = `http://127.0.0.1:${port}`;
    const exited = new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`llama-server exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`))));
    this.child = child;
    child.once("exit", () => {
      // Crashed or stopped: the next suggestion starts a new one.
      if (this.child !== child) return;
      this.child = undefined;
      this.server = undefined;
    });
    const ready = (async () => {
      const deadline = Date.now() + START_MS;
      while (Date.now() < deadline) {
        const response = await fetch(`${url}/health`).catch(() => undefined);
        if (response?.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("llama-server did not start in time");
    })();
    try {
      await Promise.race([ready, exited]);
    } catch (error) {
      child.kill();
      // A GPU build that cannot run here (no Vulkan driver): the next build of the list is fetched and tried.
      this.failed.add(executable.build.id);
      this.executable = undefined;
      log.error("autocomplete", `${executable.build.id}: ${(error as Error).message}`);
      const next = this.builds.some((build) => !this.failed.has(build.id));
      if (next && this.enabled) void this.install();
      else this.set({ phase: "error", error: `The local model would not start: ${(error as Error).message}` });
      throw error;
    }
    this.set({ phase: "ready" });
    return { child, url, key };
  }

  /** Stops the server; the next suggestion starts it again. */
  stop(): void {
    clearTimeout(this.idle);
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    const server = this.server;
    this.server = undefined;
    this.child = undefined;
    void server?.then(({ child }) => child.kill()).catch(() => undefined);
  }

  /** The ghost text for `request`, or "" (off, not ready, nothing worth showing, or overtaken by a newer request). */
  async suggest(client: string, request: SuggestRequest): Promise<string> {
    this.inflight.get(client)?.abort();
    if (!this.enabled || !this.executable || !wantsSuggestion(request.draft)) return "";
    const controller = new AbortController();
    this.inflight.set(client, controller);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    try {
      const [server, prompts] = await Promise.all([this.start(), this.history.prompts(request.cwd)]);
      if (controller.signal.aborted) return "";
      const prompt = buildPrompt(request, pickExamples(request.draft, prompts));
      const response = await fetch(`${server.url}/completion`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.key}` },
        body: JSON.stringify({ prompt, n_predict: 16, temperature: 0, stop: ["\n"], cache_prompt: true }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SUGGEST_MS)]),
      });
      if (!response.ok) return "";
      const body = (await response.json()) as { content?: unknown };
      return typeof body.content === "string" ? cleanSuggestion(body.content, request.draft) : "";
    } catch {
      return "";
    } finally {
      if (this.inflight.get(client) === controller) this.inflight.delete(client);
    }
  }

  dispose(): void {
    this.enabled = false;
    this.installing?.abort.abort();
    this.stop();
  }
}
