// Voice calls' main side (docs/DESIGN.md, Voice calls): installs the pinned llama.cpp server and LFM3-Audio-2B when the
// setting turns on, runs the server on 127.0.0.1 behind a random API key from the first call, and stops it a while
// after the last one. One call at a time; the window streams the microphone in and plays the speech that comes back.
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { projectOf } from "../../shared/board";
import { type CallControl, type CallEvent, INPUT_RATE, OUTPUT_RATE, type VoiceStatus } from "../../shared/voice";
import { log } from "../log";
import type { Download, ServerBuild } from "../autocomplete/assets";
import { type Fetch, fetchVerified, installServer } from "../autocomplete/install";
import { launchLlamaServer, type LlamaServer } from "../autocomplete/server";
import { MODEL, PROJECTOR, serverBuilds } from "./assets";
import { type RealtimeConnect, type RealtimeEvent, VoiceCall } from "./call";
import { VOICE_INSTRUCTIONS, VOICE_TOOLS, type VoiceSources, VoiceTools } from "./tools";

/** The server stops after this long without a call, giving its memory back. */
const IDLE_MS = 10 * 60_000;
/** Loading 1.4 GB and compiling Metal shaders the first time. */
const START_MS = 120_000;
const CONNECT_MS = 15_000;

export interface VoiceDeps {
  /** userData/voice. */
  dir: string;
  fetch: Fetch;
  sources: VoiceSources;
  onStatus(status: VoiceStatus): void;
  /** A call's events, for the window that started it. */
  onEvent(id: string, event: CallEvent): void;
  /** Tests swap in their own builds and model; the app uses the pins in assets.ts. */
  builds?: readonly ServerBuild[];
  model?: Download & { file: string };
  projector?: Download & { file: string };
}

export class Voice {
  private status: VoiceStatus = { phase: "off" };
  private enabled = false;
  private executable: { build: ServerBuild; path: string } | undefined;
  private readonly failed = new Set<string>();
  private installing: { abort: AbortController; done: Promise<void> } | undefined;
  private server: Promise<LlamaServer> | undefined;
  private child: ChildProcess | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private call: { id: string; call: VoiceCall } | undefined;
  private readonly builds: readonly ServerBuild[];
  private readonly model: Download & { file: string };
  private readonly projector: Download & { file: string };

  constructor(private readonly deps: VoiceDeps) {
    this.builds = deps.builds ?? serverBuilds();
    this.model = deps.model ?? MODEL;
    this.projector = deps.projector ?? PROJECTOR;
  }

  get(): VoiceStatus {
    return this.status;
  }

  private set(status: Partial<VoiceStatus>): void {
    this.status = { phase: this.status.phase, ...status };
    this.deps.onStatus(this.status);
  }

  /** Follows the setting: on installs what is missing, off ends the call and stops the server and any download. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      void this.install();
      return;
    }
    this.installing?.abort.abort();
    this.endCall();
    this.stop();
    this.set({ phase: "off", progress: undefined, error: undefined });
  }

  /** Tries the install again after an error (Settings' Retry). */
  retry(): void {
    if (!this.enabled || this.status.phase !== "error") return;
    this.failed.clear();
    if (this.executable) this.set({ phase: "ready", error: undefined });
    else void this.install();
  }

  private install(): Promise<void> {
    if (this.installing) return this.installing.done;
    const abort = new AbortController();
    const done = (async () => {
      const build = this.builds.find((candidate) => !this.failed.has(candidate.id));
      try {
        if (!build) throw new Error("Voice calls have no local model build for this computer.");
        const total = build.size + this.model.size + this.projector.size;
        let received = 0;
        let shown = -1;
        const onBytes = (bytes: number) => {
          received += bytes;
          const progress = Math.min(0.99, Math.floor((received / total) * 100) / 100);
          if (progress > shown) this.set({ phase: "downloading", progress: (shown = progress), error: undefined });
        };
        const path = await installServer(this.deps.fetch, build, join(this.deps.dir, "server"), onBytes, abort.signal);
        await fetchVerified(this.deps.fetch, this.model, this.path(this.model), onBytes, abort.signal);
        await fetchVerified(this.deps.fetch, this.projector, this.path(this.projector), onBytes, abort.signal);
        this.executable = { build, path };
        if (this.enabled) this.set({ phase: "ready", progress: undefined });
      } catch (error) {
        if (abort.signal.aborted) return;
        log.error("voice", `install failed: ${(error as Error).message}`);
        this.set({ phase: "error", progress: undefined, error: build ? `Could not download the model: ${(error as Error).message}` : (error as Error).message });
      }
    })().finally(() => {
      if (this.installing?.abort === abort) this.installing = undefined;
    });
    this.installing = { abort, done };
    return done;
  }

  private path(download: { file: string }): string {
    return join(this.deps.dir, "models", download.file);
  }

  private start(): Promise<LlamaServer> {
    this.server ??= this.launch().catch((error: Error) => {
      this.server = undefined;
      throw error;
    });
    return this.server;
  }

  private async launch(): Promise<LlamaServer> {
    const executable = this.executable;
    if (!executable) throw new Error("Voice calls are not installed yet.");
    this.set({ phase: "starting" });
    // Two slots: the call's session and the speech of its answers or announcements, at the same time.
    const args = ["-m", this.path(this.model), "--mmproj", this.path(this.projector), "-c", "16384", "-np", "2", "-ngl", "99"];
    try {
      const server = await launchLlamaServer(executable.path, args, START_MS, (child) => {
        // Crashed or stopped: the call on it ends, and the next one starts a new server.
        if (this.child !== child) return;
        this.child = undefined;
        this.server = undefined;
        this.endCall(undefined, "The voice model stopped.");
      });
      this.child = server.child;
      this.set({ phase: "ready" });
      return server;
    } catch (error) {
      // A GPU build that cannot run here (no Vulkan driver): the next build of the list is fetched and tried.
      this.failed.add(executable.build.id);
      this.executable = undefined;
      log.error("voice", `${executable.build.id}: ${(error as Error).message}`);
      if (this.builds.some((build) => !this.failed.has(build.id)) && this.enabled) void this.install();
      else this.set({ phase: "error", error: `The voice model would not start: ${(error as Error).message}` });
      throw error;
    }
  }

  private stop(): void {
    clearTimeout(this.idle);
    const server = this.server;
    this.server = undefined;
    this.child = undefined;
    void server?.then(({ child }) => child.kill()).catch(() => undefined);
  }

  /**
   * Starts the call `id` (the window's name for it) about the project `cwd` is in, ending one going on; its events
   * go to onEvent until it ends. The server may still be loading: the call's state says so.
   */
  startCall(id: string, cwd: string): void {
    if (!this.enabled || !this.executable) throw new Error("Voice calls are not ready yet.");
    this.endCall();
    clearTimeout(this.idle);
    const project = projectOf(cwd);
    // Announcements name a chat as the sidebar does (an open chat's own title may still be its folder's name).
    const titles = new Map<string, string>();
    const refresh = () =>
      void this.deps.sources
        .sessions()
        .then((groups) => groups.forEach((group) => group.sessions.forEach((session) => titles.set(session.path, session.title))))
        .catch(() => undefined);
    refresh();
    const call = new VoiceCall(
      {
        connect: (onEvent, onClose) => this.start().then((server) => connect(server, onEvent, onClose)),
        tts: (text, signal) => this.speak(text, signal),
        tools: new VoiceTools(this.deps.sources, project),
        instructions: VOICE_INSTRUCTIONS,
        toolDefinitions: VOICE_TOOLS,
        live: () => {
          refresh();
          return this.deps.sources.live().map((chat) => (chat.sessionPath && titles.has(chat.sessionPath) ? { ...chat, title: titles.get(chat.sessionPath)! } : chat));
        },
        emit: (event) => {
          if (event.type === "ended" && this.call?.id === id) {
            this.call = undefined;
            this.idle = setTimeout(() => this.stop(), IDLE_MS);
          }
          this.deps.onEvent(id, event);
        },
      },
      (chat) => projectOf(chat.cwd) === project,
    );
    this.call = { id, call };
    void call.start();
  }

  /** Microphone audio for the call `id`; dropped once it ended. */
  audio(id: string, pcm: Float32Array): void {
    if (this.call?.id === id) this.call.call.audio(pcm);
  }

  control(id: string, control: CallControl & { micMuted?: boolean }): void {
    if (this.call?.id !== id) return;
    if (control.micMuted) this.call.call.micMuted();
    this.call.call.control(control);
  }

  endCall(id?: string, reason = "ended"): void {
    if (!this.call || (id !== undefined && this.call.id !== id)) return;
    this.call.call.end(reason);
  }

  /** Speech for `text` from /tts, as 24 kHz float chunks while it is made. */
  private async *speak(text: string, signal: AbortSignal): AsyncIterable<Float32Array> {
    const server = await this.start();
    const response = await fetch(`${server.url}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.key}` },
      body: JSON.stringify({ input: text, voice: "female", response_format: "pcm", stream: true }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`the speech model answered ${response.status}`);
    const rate = Number(/rate=(\d+)/.exec(response.headers.get("content-type") ?? "")?.[1] ?? OUTPUT_RATE);
    if (rate !== OUTPUT_RATE) throw new Error(`the speech model speaks at ${rate} Hz, not ${OUTPUT_RATE}`);
    let rest = new Uint8Array(0);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const bytes = new Uint8Array(rest.length + chunk.length);
      bytes.set(rest);
      bytes.set(chunk, rest.length);
      const whole = bytes.length - (bytes.length % 4);
      rest = bytes.slice(whole);
      if (whole) yield new Float32Array(bytes.slice(0, whole).buffer);
    }
  }

  dispose(): void {
    this.enabled = false;
    this.installing?.abort.abort();
    this.endCall(undefined, "pi-gna quit");
    this.stop();
  }
}

/** A /v1/realtime session on `server`, resolved once the server greets it with `session.created`. */
function connect(server: LlamaServer, onEvent: (event: RealtimeEvent) => void, onClose: (reason: string) => void): ReturnType<RealtimeConnect> {
  return new Promise((resolve, reject) => {
    // Node's WebSocket (undici) takes headers, which a browser's does not: the key goes in Authorization.
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/v1/realtime`, { headers: { authorization: `Bearer ${server.key}` } } as unknown as string[]);
    let open = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no answer in time"));
    }, CONNECT_MS);
    const realtime = {
      send: (event: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event)),
      close: () => ws.close(),
    };
    ws.onmessage = (message) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(String(message.data)) as RealtimeEvent;
      } catch {
        return;
      }
      if (open) return onEvent(event);
      if (event.type !== "session.created") return;
      clearTimeout(timer);
      const rate = (event.session as { audio?: { input?: { format?: { rate?: unknown } } } } | undefined)?.audio?.input?.format?.rate;
      if (rate !== undefined && rate !== INPUT_RATE) {
        ws.close();
        return reject(new Error(`the model hears at ${String(rate)} Hz, not ${INPUT_RATE}`));
      }
      open = true;
      resolve(realtime);
    };
    ws.onerror = () => {
      if (open) return;
      clearTimeout(timer);
      reject(new Error("could not connect"));
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (!open) return reject(new Error(`closed (${event.code})`));
      onClose(event.reason || "The voice model closed the call.");
    };
  });
}
