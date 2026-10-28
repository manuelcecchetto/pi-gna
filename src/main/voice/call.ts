// One voice call (docs/DESIGN.md, Voice calls), one answer at a time. It listens until you stop talking, writes down what
// you said (the speech model's transcription session on /v1/realtime), asks the brain (brain.ts, a pi chat on a capable
// model) and says its answer (/tts). It waits for you to finish: what sounds unfinished ("…and", a comma) gets more time,
// and talking again while it thinks drops that answer and adds to what you said. It does not listen while it speaks, nor
// just after: its own voice came back through the microphone and it answered itself in a loop. Stop (the orb, Space)
// cuts it short.
import { type CallControl, type CallEvent, Endpointer, expectedSeconds, FRAME, level, sentences, soundsUnfinished, spoken } from "../../shared/voice";

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
  /** The brain's answer to what the user said. */
  ask(said: string, signal: AbortSignal): Promise<string>;
  emit(event: CallEvent): void;
}

/** Audio kept from before a turn starts, so its first syllable is not cut (frames of 20 ms). */
const PREROLL = 15;
/** The microphone stays unheard this long after its speech stopped playing: the room's echo dies down. */
const DEAF_AFTER_MS = 700;
const TRANSCRIBE_MS = 15_000;
/** What sounds unfinished waits this much longer for the rest. */
const HOLD_MS = 1500;

export class VoiceCall {
  private realtime: Realtime | undefined;
  private ready = false;
  private ended = false;
  private readonly endpointer = new Endpointer();
  private rest = new Float32Array(0);
  private preroll: Float32Array[] = [];
  /** What you said since the last answer, written down. */
  private pending = "";
  /** Commits waiting for their transcript, oldest first. */
  private readonly transcripts: ((text: string) => void)[] = [];
  private hold: ReturnType<typeof setTimeout> | undefined;
  /** The brain is working on `pending`: talking again calls it off. */
  private asking: AbortController | undefined;
  /** Its answer is being said: the microphone is not listened to. */
  private speech: AbortController | undefined;
  private speechId = 0;
  private playing = false;
  private deafUntil = 0;
  private assistantMuted = false;
  private onUpdated: (() => void) | undefined;

  constructor(private readonly deps: CallDeps) {}

  /** Opens the transcription session; the call listens once that is done. */
  async start(): Promise<void> {
    this.state("connecting");
    try {
      const updated = new Promise<void>((resolve) => (this.onUpdated = resolve));
      this.realtime = await this.deps.connect(
        (event) => this.onEvent(event),
        (reason) => this.end(reason),
      );
      if (this.ended) return this.realtime.close();
      this.realtime.send({ type: "session.update", session: { type: "transcription" } });
      await updated;
    } catch (error) {
      this.deps.emit({ type: "error", message: `The voice model did not answer: ${(error as Error).message}` });
      this.end("failed");
      return;
    }
    if (this.ended) return;
    this.ready = true;
    this.state("listening");
  }

  private get deaf(): boolean {
    return this.speech !== undefined || this.playing || Date.now() < this.deafUntil;
  }

  /** Microphone audio, 16 kHz mono, in chunks of any length. */
  audio(pcm: Float32Array): void {
    if (!this.ready || this.ended) return;
    if (this.deaf) {
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
        // You go on: an answer being thought about is dropped, and what you say now is added to it.
        clearTimeout(this.hold);
        this.asking?.abort();
        this.asking = undefined;
        this.state("hearing");
        out.push(...this.preroll, frame);
        this.preroll = [];
      } else if (this.endpointer.active || edge === "end") out.push(frame);
      else {
        this.preroll.push(frame);
        if (this.preroll.length > PREROLL) this.preroll.shift();
      }
      if (edge === "end") {
        this.append(out.splice(0));
        void this.turnEnded();
      }
    }
    this.rest = all.slice(at);
    this.append(out);
  }

  /** The microphone was muted: a turn going on is dropped unheard. */
  micMuted(): void {
    if (!this.endpointer.active) return;
    this.endpointer.reset();
    this.realtime?.send({ type: "input_audio_buffer.clear" });
    this.state("listening");
  }

  control(control: CallControl): void {
    if (control.playing !== undefined) {
      this.playing = control.playing;
      if (!control.playing) this.deafUntil = Date.now() + DEAF_AFTER_MS;
    }
    if (control.assistantMuted !== undefined) {
      this.assistantMuted = control.assistantMuted;
      if (control.assistantMuted) this.deps.emit({ type: "flush" });
    }
    if (control.interrupt) this.stop();
  }

  private append(frames: Float32Array[]): void {
    if (frames.length) this.realtime?.send({ type: "input_audio_buffer.append", audio: pcm16(frames) });
  }

  /** You stopped talking: write it down, then answer, or wait a little more when it sounds unfinished. */
  private async turnEnded(): Promise<void> {
    this.state("thinking");
    let heard: string;
    try {
      heard = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("writing down what you said took too long")), TRANSCRIBE_MS);
        this.transcripts.push((text) => {
          clearTimeout(timer);
          resolve(text);
        });
        this.realtime?.send({ type: "input_audio_buffer.commit" });
      });
    } catch (error) {
      if (!this.ended) this.deps.emit({ type: "error", message: (error as Error).message });
      return this.idle();
    }
    if (this.ended) return;
    this.pending = [this.pending, heard.trim()].filter(Boolean).join(" ");
    // Already talking again: the answer waits for the end of that.
    if (this.endpointer.active) return;
    clearTimeout(this.hold);
    if (soundsUnfinished(this.pending)) {
      this.state("listening");
      this.hold = setTimeout(() => void this.answer(), HOLD_MS);
    } else void this.answer();
  }

  /** Asks the brain about what you said and says its answer, unless you go on talking first. */
  private async answer(): Promise<void> {
    const said = this.pending.trim();
    if (!said || this.ended || this.endpointer.active) return this.idle();
    const asking = (this.asking = new AbortController());
    this.deps.emit({ type: "heard", text: said });
    this.state("thinking");
    let reply: string;
    try {
      // Stop and talking again end the wait at once, whether or not the brain has stopped yet.
      const stopped = new Promise<never>((_, reject) => asking.signal.addEventListener("abort", () => reject(new Error("stopped"))));
      reply = await Promise.race([this.deps.ask(said, asking.signal), stopped]);
    } catch (error) {
      if (asking.signal.aborted || this.ended) return;
      this.asking = undefined;
      this.pending = "";
      this.deps.emit({ type: "error", message: (error as Error).message });
      return this.idle();
    }
    if (this.asking !== asking || this.ended) return;
    this.asking = undefined;
    this.pending = "";
    const speech = (this.speech = new AbortController());
    try {
      await this.say(reply, speech.signal);
    } catch (error) {
      if (!speech.signal.aborted) this.deps.emit({ type: "error", message: `Speaking failed: ${(error as Error).message}` });
    } finally {
      if (this.speech === speech) {
        this.speech = undefined;
        this.deafUntil = Math.max(this.deafUntil, Date.now() + (this.playing ? 0 : DEAF_AFTER_MS));
      }
    }
    this.idle();
  }

  private shown: string | undefined;

  /** The call's state, sent only when it changes. */
  private state(state: "connecting" | "listening" | "hearing" | "thinking"): void {
    if (state === this.shown) return;
    this.shown = state;
    this.deps.emit({ type: "state", state });
  }

  private idle(): void {
    if (!this.ended && !this.endpointer.active && !this.asking) this.state("listening");
  }

  /** Says `text`, a sentence at a time; the window plays each as it comes. */
  private async say(text: string, signal: AbortSignal): Promise<void> {
    const line = spoken(text);
    if (!line) return;
    this.deps.emit({ type: "reply", text: line });
    if (this.assistantMuted) return;
    for (const sentence of sentences(line)) {
      const id = ++this.speechId;
      this.deps.emit({ type: "speech", id, seconds: expectedSeconds(sentence) });
      for await (const pcm of this.deps.tts(sentence, signal)) {
        if (signal.aborted) return;
        this.deps.emit({ type: "audio", id, pcm });
      }
      if (signal.aborted) return;
      this.deps.emit({ type: "speechEnd", id });
    }
  }

  /** Stop: what it is thinking or saying is dropped, and it listens again. */
  private stop(): void {
    if (!this.asking && !this.speech && !this.playing) return;
    clearTimeout(this.hold);
    this.asking?.abort();
    this.asking = undefined;
    this.speech?.abort();
    this.speech = undefined;
    this.pending = "";
    this.deps.emit({ type: "flush" });
    this.playing = false;
    this.deafUntil = Date.now() + DEAF_AFTER_MS;
    this.idle();
  }

  private onEvent(event: RealtimeEvent): void {
    if (this.ended) return;
    if (event.type === "session.updated") {
      this.onUpdated?.();
      this.onUpdated = undefined;
    } else if (event.type === "conversation.item.input_audio_transcription.completed") this.transcripts.shift()?.(String(event.transcript ?? ""));
    else if (event.type === "error") this.deps.emit({ type: "error", message: String((event.error as { message?: unknown } | undefined)?.message ?? "the voice model failed") });
  }

  end(reason = "ended"): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    clearTimeout(this.hold);
    this.asking?.abort();
    this.speech?.abort();
    this.onUpdated?.();
    this.realtime?.close();
    this.deps.emit({ type: "ended", reason });
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
