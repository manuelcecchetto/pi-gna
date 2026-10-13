// Dictation (Settings > Agent > Beta, off by default): the composer's mic records what you say and a speech model that
// runs on this computer (src/main/dictation) writes it into the message at the caret. Nothing leaves the computer.
// Everything here is pure, for both sides and the tests.

import type { AutocompletePhase } from "./autocomplete";

/** Where the local model is: off, being fetched (0..1), loading, ready, or failed (the same phases as autocomplete). */
export interface DictationStatus {
  phase: AutocompletePhase;
  /** 0..1 while downloading. */
  progress?: number;
  /** Why the last install or start failed, in words for the Settings row. */
  error?: string;
}

/** The model takes 16 kHz mono float PCM. */
export const SAMPLE_RATE = 16_000;
/** The longest recording: past it the composer stops and transcribes what it has. */
export const MAX_SECONDS = 300;
export const MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS;

/**
 * The text to insert for a transcript between `before` and `after` (the draft around the caret): a space to separate
 * it from a word before it and from a word after it, and nothing for an empty transcript.
 */
export function dictationInsert(before: string, transcript: string, after: string): string {
  const text = transcript.trim();
  if (!text) return "";
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^[\s.,;:!?)\]}]/.test(after) ? " " : "";
  return `${lead}${text}${tail}`;
}
