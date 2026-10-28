// Voice calls (Settings > Agent > Beta, off by default): talk to pi-gna. A speech model that runs on this computer
// (LFM3-Audio-2B on llama.cpp, src/main/voice) writes down what you say and speaks the answers; a "Voice call" chat on
// a capable model (the voice task's, gpt-6.1-terra by default) decides what to answer and which chats to tell what.
// Your words go to that model's provider like a typed message. Everything here is pure, for both sides and the tests.

import type { AutocompletePhase } from "./autocomplete";

/** Where the local model is: off, being fetched (0..1), loading, ready, or failed (the same phases as autocomplete). */
export interface VoiceStatus {
  phase: AutocompletePhase;
  /** 0..1 while downloading. */
  progress?: number;
  /** Why the last install or start failed, in words for the Settings row. */
  error?: string;
}

/** The microphone goes to main as 16 kHz mono float PCM; speech comes back at 24 kHz. */
export const INPUT_RATE = 16_000;
export const OUTPUT_RATE = 24_000;
/** The longest chunk of microphone audio one message may carry (1 s). */
export const MAX_CHUNK = INPUT_RATE;

/** What the call is doing, as the orb shows it. Speaking is the client's: it plays what main sent. */
export type CallState = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended";

/** What main tells the window about a call. */
export type CallEvent =
  | { type: "state"; state: Exclude<CallState, "speaking"> }
  /** What you said, as written down. */
  | { type: "heard"; text: string }
  /** What the assistant says (also when it is muted). */
  | { type: "reply"; text: string }
  /** One sentence's speech begins: `seconds` is its expected length, so playback can wait until it will not stall. */
  | { type: "speech"; id: number; seconds: number }
  | { type: "audio"; id: number; pcm: Float32Array }
  | { type: "speechEnd"; id: number }
  /** It stopped talking (Stop, or Mute assistant): drop the speech not yet played. */
  | { type: "flush" }
  | { type: "error"; message: string }
  | { type: "ended"; reason: string };

/** What the window may change during a call. */
export interface CallControl {
  /** Speech is playing in the window: the microphone is not listened to meanwhile. */
  playing?: boolean;
  /** The assistant answers in text only. */
  assistantMuted?: boolean;
  /** Stop thinking or talking and listen again. */
  interrupt?: boolean;
}

/** Endpointing runs on 20 ms frames. */
export const FRAME = INPUT_RATE / 50;

export interface EndpointerOptions {
  /** Speech this long starts a turn: shorter sounds (a click, a cough) do not. */
  startMs: number;
  /** Silence this long after speech ends the turn. */
  endMs: number;
  /** A turn this long ends even without a pause. */
  maxMs: number;
}

export const ENDPOINTER: EndpointerOptions = { startMs: 160, endMs: 800, maxMs: 30_000 };

/** The level of one frame in dBFS. */
export function level(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return 10 * Math.log10(sum / Math.max(1, frame.length) + 1e-12);
}

/**
 * Finds where someone starts and stops talking from the level of 20 ms frames: louder than the room's noise floor by
 * a margin counts as voice. The floor follows the quiet frames (falling at once, rising slowly), so a fan or a noisy
 * room raises the bar. `boost` raises it more, for while the assistant's own voice plays from the speakers.
 */
export class Endpointer {
  /** The room's level; the first frame sets it (a call starts before anyone talks). */
  private floor: number | undefined;
  private speaking = false;
  private voiced = 0;
  private silent = 0;
  private length = 0;

  constructor(private readonly options: EndpointerOptions = ENDPOINTER) {}

  get active(): boolean {
    return this.speaking;
  }

  /** One frame's level: "start" when a turn begins, "end" when it ends, else undefined. */
  frame(db: number, boost = 0): "start" | "end" | undefined {
    const floor = (this.floor ??= Math.min(-25, Math.max(-80, db)));
    const threshold = Math.max(floor + 12, -50) + boost;
    const voice = db > threshold;
    const ms = 1000 / 50;
    if (!this.speaking) {
      const next = db < floor ? db : voice ? floor : floor + 0.05 * (db - floor);
      this.floor = Math.min(-25, Math.max(-80, next));
      this.voiced = voice ? this.voiced + 1 : 0;
      if (this.voiced * ms < this.options.startMs) return undefined;
      this.speaking = true;
      this.silent = 0;
      this.length = this.voiced;
      return "start";
    }
    this.length++;
    this.silent = voice ? 0 : this.silent + 1;
    if (this.silent * ms < this.options.endMs && this.length * ms < this.options.maxMs) return undefined;
    this.speaking = false;
    this.voiced = 0;
    return "end";
  }

  /** Forget a turn going on (the microphone was muted). */
  reset(): void {
    this.speaking = false;
    this.voiced = 0;
    this.silent = 0;
  }
}

/** The text as it should be said: no markdown, links, code or chat ids, and at most a few sentences. */
export function spoken(text: string, maxChars = 400): string {
  const out = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S*[^\s.,;:!?)\]]/g, "a link")
    .replace(/\s*\((?:id|ID|thread|Thread)?:?\s*[0-9a-f]{4,}\)/g, "")
    .replace(/^\s*(?:#+|[-*•]|\d+\.)\s+/gm, "")
    .replace(/[*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length <= maxChars) return out;
  let kept = "";
  for (const sentence of sentences(out)) {
    if (kept && kept.length + 1 + sentence.length > maxChars) break;
    kept = kept ? `${kept} ${sentence}` : sentence;
  }
  return kept.length <= maxChars ? kept : `${kept.slice(0, maxChars).replace(/\s+\S*$/, "")}…`;
}

/** The text split into sentences, short ones joined to the next, so each is spoken as it is ready. */
export function sentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last !== undefined && last.length < 24) out[out.length - 1] = `${last} ${part}`;
    else out.push(part);
  }
  return out;
}

/** About how long `text` takes to say, at 2.6 words a second. */
export function expectedSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words / 2.6 + 0.3;
}

/**
 * Whether a sentence's speech can start playing without running dry: the speech still to come must be made before
 * what is buffered has played. `received` and `expected` are seconds of audio, `rate` is seconds of audio made per
 * second (below 1 on a slow computer). A small margin covers the guess of `expected`.
 */
export function readyToPlay(received: number, expected: number, rate: number, done: boolean): boolean {
  if (done) return received > 0;
  if (received <= 0) return false;
  if (rate >= 1.1) return true;
  const left = Math.max(0, expected - received);
  return left * Math.max(0, 1 - rate) / Math.max(rate, 0.05) + 0.25 <= received;
}

/** Words a sentence does not end on: when what was said stops on one, the speaker is likely not done. */
const OPEN_ENDS = new Set([
  "and", "but", "or", "so", "because", "then", "also", "the", "a", "an", "to", "with", "that", "which", "if", "of", "for", "about", "like", "um", "uh", "erm", "hmm",
  "e", "ma", "o", "oppure", "perché", "che", "quindi", "poi", "il", "lo", "la", "i", "gli", "le", "un", "una", "di", "da", "con", "per", "tipo", "cioè", "ehm",
]);

/**
 * Whether what was said sounds unfinished, so the call waits a little longer for the rest: it stops on a joining word,
 * a comma or a trailing "...", or runs on for several words with no sentence end.
 */
export function soundsUnfinished(text: string): boolean {
  const said = text.trim();
  if (!said) return false;
  if (/(,|;|:|\.\.\.|…|-)$/.test(said)) return true;
  const words = said.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const last = words.at(-1);
  if (last && OPEN_ENDS.has(last) && !/[.?!]$/.test(said)) return true;
  return !/[.?!]["')\]]*$/.test(said) && words.length > 3;
}
