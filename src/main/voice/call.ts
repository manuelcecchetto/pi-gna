// One voice call (docs/DESIGN.md, Voice calls). Three things go on at once:
// - listening: the microphone's audio streams into a /v1/realtime session while you talk, so the model has read it by
//   the time you stop; a level-based endpointer finds where a turn starts and ends (the server has no turn detection);
// - acting: the session answers in text, which is where the 2B model calls tools reliably (in its voice mode it says
//   "I'll send that" and does not), and the tools run here on the project's chats;
// - speaking: the final text is said by /tts sentence by sentence while the window plays it, and the chats of the
//   project keep working: one that finishes, fails or needs you during the call is announced.
// It does not listen while it speaks (its own voice came back through the microphone); Mute assistant stops it. Going on
// talking while it writes an answer cancels that answer.
import type { AttentionSummary } from "../../shared/host-api";
import { type CallControl, type CallEvent, Endpointer, expectedSeconds, FRAME, level, sentences, spoken } from "../../shared/voice";
import type { ToolResult } from "./tools";

/** One /v1/realtime session, as the call sees it. */
export interface Realtime {
  send(event: Record<string, unknown>): void;
  close(): void;
}

export type RealtimeEvent = { type: string; [key: string]: unknown };

/** Opens a session; resolves once the server sent `session.created`. */
export type RealtimeConnect = (onEvent: (event: RealtimeEvent) => void, onClose: (reason: string) => void) => Promise<Realtime>;

export interface CallDeps {
  connect: RealtimeConnect;
  /** Speech for `text`, as 24 kHz mono float chunks while it is made. */
  tts(text: string, signal: AbortSignal): AsyncIterable<Float32Array>;
  tools: { run(name: string, args: Record<string, unknown>): Promise<ToolResult> };
  instructions: string;
  toolDefinitions: readonly unknown[];
  emit(event: CallEvent): void;
  /** The project's open chats right now, for the announcements; leave out for none. */
  live?: () => AttentionSummary[];
}

/** Tool rounds one turn may take before the model must answer. */
const MAX_ROUNDS = 4;
/** Audio kept from before a turn starts, so its first syllable is not cut (frames of 20 ms). */
const PREROLL = 15;
/**
 * The microphone is not listened to while it speaks and this long after: the speakers' echo came back as a turn of
 * its own and it answered itself in a loop (echo cancellation did not stop it on a MacBook's speakers).
 */
const DEAF_AFTER_MS = 700;
const WATCH_MS = 2000;

interface Call {
  call_id: string;
  name: string;
  arguments: string;
}

/** The news of the project's chats between two looks: which finished, failed or started waiting for the user. */
export class ChatWatcher {
  private last: Map<string, AttentionSummary> | undefined;

  constructor(private readonly project: (chat: AttentionSummary) => boolean) {}

  look(chats: AttentionSummary[]): string[] {
    const now = new Map(chats.filter((chat) => this.project(chat)).map((chat) => [chat.sessionPath ?? chat.handle, chat] as const));
    const before = this.last;
    this.last = now;
    if (!before) return [];
    const news: string[] = [];
    for (const [key, chat] of now) {
      const was = before.get(key);
      if (!was) continue;
      const title = chat.title.length > 60 ? `${chat.title.slice(0, 57)}…` : chat.title;
      if (chat.attention === "waiting" && was.attention !== "waiting") news.push(`${title} needs you.`);
      else if (was.running && !chat.running) news.push(chat.attention === "failed" || chat.settled?.outcome === "error" ? `${title} failed.` : `${title} finished.`);
    }
    return news;
  }
}

export class VoiceCall {
  private realtime: Realtime | undefined;
  private ready = false;
  private ended = false;
  private readonly endpointer = new Endpointer();
  private rest = new Float32Array(0);
  private preroll: Float32Array[] = [];
  /** Frames heard while a cancelled response winds down: they go in after it. */
  private held: Float32Array[] = [];
  private responding = false;
  private cancelled = false;
  /** The turn ended while a cancelled response wound down: commit it once that is done. */
  private commitAfter = false;
  private text = "";
  private calls: Call[] = [];
  private rounds = 0;
  private speech: AbortController | undefined;
  private speechId = 0;
  private playing = false;
  private deafUntil = 0;
  private assistantMuted = false;
  private readonly news: string[] = [];
  private watch: ReturnType<typeof setInterval> | undefined;
  private readonly watcher: ChatWatcher | undefined;

  constructor(
    private readonly deps: CallDeps,
    project?: (chat: AttentionSummary) => boolean,
  ) {
    this.watcher = deps.live && project ? new ChatWatcher(project) : undefined;
  }

  /** Opens the session and tells it who it is; the call listens once that is done. */
  async start(): Promise<void> {
    this.deps.emit({ type: "state", state: "connecting" });
    try {
      const updated = new Promise<void>((resolve) => (this.onUpdated = resolve));
      this.realtime = await this.deps.connect(
        (event) => void this.onEvent(event),
        (reason) => this.end(reason),
      );
      if (this.ended) return this.realtime.close();
      this.realtime.send({ type: "session.update", session: { type: "realtime", instructions: this.deps.instructions, output_modalities: ["text"], tools: this.deps.toolDefinitions, tool_choice: "auto" } });
      await updated;
    } catch (error) {
      this.deps.emit({ type: "error", message: `The voice model did not answer: ${(error as Error).message}` });
      this.end("failed");
      return;
    }
    if (this.ended) return;
    this.ready = true;
    this.deps.emit({ type: "state", state: "listening" });
    if (this.watcher && this.deps.live) {
      this.watcher.look(this.deps.live());
      this.watch = setInterval(() => this.look(), WATCH_MS);
    }
  }

  private onUpdated: (() => void) | undefined;

  /** Microphone audio, 16 kHz mono, in chunks of any length. */
  audio(pcm: Float32Array): void {
    if (!this.ready || this.ended) return;
    if (this.playing || this.speech || Date.now() < this.deafUntil) {
      this.rest = new Float32Array(0);
      this.preroll = [];
      return;
    }
    const all = new Float32Array(this.rest.length + pcm.length);
    all.set(this.rest);
    all.set(pcm, this.rest.length);
    const out: Float32Array[] = [];
    let at = 0;
    for (; at + FRAME <= all.length; at += FRAME) {
      const frame = all.slice(at, at + FRAME);
      const edge = this.endpointer.frame(level(frame));
      if (edge === "start") {
        this.interrupt();
        this.deps.emit({ type: "state", state: "hearing" });
        out.push(...this.preroll, frame);
        this.preroll = [];
      } else if (this.endpointer.active || edge === "end") out.push(frame);
      else {
        this.preroll.push(frame);
        if (this.preroll.length > PREROLL) this.preroll.shift();
      }
      if (edge === "end") {
        this.append(out.splice(0));
        this.turnEnded();
      }
    }
    this.rest = all.slice(at);
    this.append(out);
  }

  /** The microphone was muted: a turn going on is dropped unheard. */
  micMuted(): void {
    if (!this.endpointer.active) return;
    this.endpointer.reset();
    this.deps.emit({ type: "state", state: "listening" });
  }

  control(control: CallControl): void {
    if (control.playing !== undefined) {
      this.playing = control.playing;
      if (!control.playing) {
        this.deafUntil = Date.now() + DEAF_AFTER_MS;
        this.announce();
      }
    }
    if (control.assistantMuted !== undefined) {
      this.assistantMuted = control.assistantMuted;
      if (control.assistantMuted) this.stopSpeech();
    }
  }

  private append(frames: Float32Array[]): void {
    if (!frames.length) return;
    if (this.responding) {
      this.held.push(...frames);
      return;
    }
    this.realtime?.send({ type: "input_audio_buffer.append", audio: pcm16(frames) });
  }

  /** You talk over the assistant: what it says stops, and a response being written is called off. */
  private interrupt(): void {
    this.stopSpeech();
    if (this.responding && !this.cancelled) {
      this.cancelled = true;
      this.realtime?.send({ type: "response.cancel" });
    }
  }

  private stopSpeech(): void {
    if (!this.speech && !this.playing) return;
    this.speech?.abort();
    this.speech = undefined;
    this.deps.emit({ type: "flush" });
  }

  private turnEnded(): void {
    if (this.responding) {
      this.commitAfter = true;
      return;
    }
    this.realtime?.send({ type: "input_audio_buffer.commit" });
    this.rounds = 0;
    this.respond();
  }

  private respond(): void {
    this.responding = true;
    this.text = "";
    this.calls = [];
    this.deps.emit({ type: "state", state: "thinking" });
    this.realtime?.send({ type: "response.create" });
  }

  private async onEvent(event: RealtimeEvent): Promise<void> {
    if (this.ended) return;
    switch (event.type) {
      case "session.updated":
        this.onUpdated?.();
        this.onUpdated = undefined;
        return;
      case "response.output_text.delta":
        if (!this.cancelled) this.text += String(event.delta ?? "");
        return;
      case "response.function_call_arguments.done":
        if (!this.cancelled) this.calls.push({ call_id: String(event.call_id ?? ""), name: String(event.name ?? ""), arguments: String(event.arguments ?? "{}") });
        return;
      case "response.done":
        return this.responseDone();
      case "error": {
        const message = String((event.error as { message?: unknown } | undefined)?.message ?? "the voice model failed");
        this.deps.emit({ type: "error", message });
        if (this.responding) {
          this.responding = false;
          this.cancelled = false;
          this.release();
          if (!this.endpointer.active) this.deps.emit({ type: "state", state: "listening" });
        }
        return;
      }
    }
  }

  /** The held audio goes in, and a turn that ended meanwhile is answered. */
  private release(): void {
    const held = this.held.splice(0);
    this.append(held);
    if (this.commitAfter) {
      this.commitAfter = false;
      this.turnEnded();
    }
  }

  private async responseDone(): Promise<void> {
    this.responding = false;
    if (this.cancelled) {
      this.cancelled = false;
      this.release();
      return;
    }
    const calls = this.calls.splice(0);
    if (calls.length && this.rounds < MAX_ROUNDS) {
      this.rounds++;
      for (const call of calls) {
        const result = await this.deps.tools.run(call.name, parseArgs(call.arguments));
        if (this.ended) return;
        if (result.action) this.deps.emit({ type: "action", text: result.action });
        this.realtime?.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: result.output } });
      }
      // You started talking while the tools ran: your turn's answer covers it.
      if (this.endpointer.active || this.commitAfter) return this.release();
      this.respond();
      return;
    }
    this.rounds = 0;
    this.release();
    if (this.responding || this.endpointer.active) return;
    await this.say(this.text);
  }

  /** Says `text`, a sentence at a time; the window plays each as it comes. */
  private async say(text: string): Promise<void> {
    const line = spoken(text);
    if (!line) {
      this.deps.emit({ type: "state", state: "listening" });
      return;
    }
    this.deps.emit({ type: "reply", text: line });
    if (this.assistantMuted) {
      this.deps.emit({ type: "state", state: "listening" });
      return this.announce();
    }
    const speech = (this.speech = new AbortController());
    try {
      for (const sentence of sentences(line)) {
        const id = ++this.speechId;
        this.deps.emit({ type: "speech", id, seconds: expectedSeconds(sentence) });
        for await (const pcm of this.deps.tts(sentence, speech.signal)) {
          if (speech.signal.aborted) break;
          this.deps.emit({ type: "audio", id, pcm });
        }
        if (speech.signal.aborted) return;
        this.deps.emit({ type: "speechEnd", id });
      }
    } catch (error) {
      if (!speech.signal.aborted) this.deps.emit({ type: "error", message: `Speaking failed: ${(error as Error).message}` });
    } finally {
      if (this.speech === speech) this.speech = undefined;
    }
    if (speech.signal.aborted || this.ended) return;
    if (!this.endpointer.active && !this.responding) this.deps.emit({ type: "state", state: "listening" });
  }

  private look(): void {
    if (!this.watcher || !this.deps.live) return;
    this.news.push(...this.watcher.look(this.deps.live()));
    this.announce();
  }

  /** Says the chats' news once nothing else is going on. */
  private announce(): void {
    if (!this.news.length || this.ended || this.endpointer.active || this.responding || this.speech || this.playing) return;
    void this.say(this.news.splice(0).join(" "));
  }

  end(reason = "ended"): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    clearInterval(this.watch);
    this.speech?.abort();
    this.speech = undefined;
    this.onUpdated?.();
    this.realtime?.close();
    this.deps.emit({ type: "ended", reason });
  }
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Float frames as base64 little-endian 16-bit PCM, what input_audio_buffer.append takes. */
export function pcm16(frames: Float32Array[]): string {
  const length = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = Buffer.alloc(length * 2);
  let at = 0;
  for (const frame of frames)
    for (const sample of frame) {
      out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), at);
      at += 2;
    }
  return out.toString("base64");
}
