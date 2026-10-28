// The window's voice call (src/shared/voice.ts): at most one, about one project. It owns the microphone stream and
// the speech player while the call lasts, and keeps what the call screen shows.
import type { CallEvent, CallState } from "../../../shared/voice";
import { createStore, useStore } from "../lib/store";
import { MicStream, SpeechPlayer } from "../lib/voice";

export interface CallLine {
  kind: "action" | "reply" | "error";
  text: string;
}

export interface VoiceCallView {
  id: string;
  cwd: string;
  state: CallState;
  micMuted: boolean;
  assistantMuted: boolean;
  /** The microphone's level, 0..1, for the orb. */
  micLevel: number;
  /** What happened, newest last: actions, what it said, errors. */
  lines: CallLine[];
  /** Why it ended, while the screen still shows it. */
  ended?: string;
}

const LINES = 6;
const calls = createStore<VoiceCallView | undefined>(undefined);

export const useVoiceCall = () => useStore(calls, (call) => call);

let mic: MicStream | undefined;
let player: SpeechPlayer | undefined;
let offEvents: (() => void) | undefined;
/** Main's state; the screen shows "speaking" while the player plays over it. */
let mainState: Exclude<CallState, "speaking"> = "connecting";
let playing = false;

const update = (change: (call: VoiceCallView) => VoiceCallView) => calls.set((call) => (call ? change(call) : call));
const addLine = (line: CallLine) => update((call) => ({ ...call, lines: [...call.lines, line].slice(-LINES) }));
const shown = (): CallState => (mainState === "hearing" || mainState === "ended" || !playing ? mainState : "speaking");

export const outputLevel = () => player?.outputLevel() ?? 0;

function onEvent(id: string, event: CallEvent): void {
  if (calls.get()?.id !== id) return;
  switch (event.type) {
    case "state":
      mainState = event.state;
      return update((call) => ({ ...call, state: shown() }));
    case "action":
    case "reply":
      return addLine({ kind: event.type, text: event.text });
    case "error":
      return addLine({ kind: "error", text: event.message });
    case "speech":
      return player?.begin(event.id, event.seconds);
    case "audio":
      return player?.push(event.id, event.pcm);
    case "speechEnd":
      return player?.finish(event.id);
    case "flush":
      return player?.flush();
    case "ended":
      release();
      mainState = "ended";
      return update((call) => ({ ...call, state: "ended", ended: event.reason }));
  }
}

function release(): void {
  mic?.stop();
  mic = undefined;
  player?.close();
  player = undefined;
  offEvents?.();
  offEvents = undefined;
  playing = false;
}

/** Starts a call about `cwd`'s project, ending one going on. */
export async function startCall(cwd: string): Promise<void> {
  endCall();
  const id = `call-${Date.now().toString(36)}`;
  mainState = "connecting";
  calls.set(() => ({ id, cwd, state: "connecting", micMuted: false, assistantMuted: false, micLevel: 0, lines: [] }));
  offEvents = window.studio.voice.onEvent(onEvent);
  player = new SpeechPlayer((now) => {
    playing = now;
    window.studio.voice.control(id, { playing: now });
    update((call) => ({ ...call, state: shown() }));
  });
  try {
    mic = await MicStream.start(
      (pcm) => window.studio.voice.audio(id, pcm),
      (db) => {
        const micLevel = Math.max(0, Math.min(1, (db + 60) / 45));
        update((call) => (Math.abs(call.micLevel - micLevel) < 0.03 ? call : { ...call, micLevel }));
      },
    );
    if (calls.get()?.id !== id) return mic.stop();
    await window.studio.voice.start(id, cwd);
  } catch (error) {
    if (calls.get()?.id !== id) return;
    release();
    const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    calls.set((call) => call && { ...call, state: "ended", ended: message, lines: [...call.lines, { kind: "error", text: message }] });
  }
}

export function endCall(): void {
  const call = calls.get();
  if (!call) return;
  if (call.state !== "ended") window.studio.voice.end(call.id);
  release();
  calls.set(() => undefined);
}

export function toggleMic(): void {
  const call = calls.get();
  if (!call || !mic) return;
  mic.muted = !call.micMuted;
  if (mic.muted) window.studio.voice.control(call.id, { micMuted: true });
  update((current) => ({ ...current, micMuted: !current.micMuted }));
}

export function toggleAssistant(): void {
  const call = calls.get();
  if (!call) return;
  const assistantMuted = !call.assistantMuted;
  if (assistantMuted) player?.flush();
  window.studio.voice.control(call.id, { assistantMuted });
  update((current) => ({ ...current, assistantMuted }));
}
