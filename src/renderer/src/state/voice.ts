// The window's voice call (src/shared/voice.ts): at most one, about one project. The window connects to GPT-Live over
// WebRTC: the microphone goes up a media track (with the browser's echo cancellation), the voice comes back on one,
// and a data channel carries events. Main creates the session from this window's offer (it holds the key) and answers
// the call's hand-offs; the transcript, hand-offs and session end are forwarded to it, its commands are sent here.
import { useEffect, useState } from "react";
import type { CallEvent, CallState, LiveEvent, VoiceStatus } from "../../../shared/voice";
import { createStore, useStore } from "../lib/store";

export interface CallLine {
  kind: "user" | "assistant" | "work" | "error";
  text: string;
  /** A hand-off's id, so its line can say when it is done. */
  work?: string;
}

export interface VoiceCallView {
  id: string;
  cwd: string;
  state: CallState;
  micMuted: boolean;
  assistantMuted: boolean;
  /** Hand-offs the chats are working on. */
  working: number;
  lines: CallLine[];
  /** Why it ended, while the screen still shows it. */
  ended?: string;
}

const LINES = 8;
/** Levels (0..1) above these count as someone talking. */
const MIC_TALKING = 0.06;
const OUT_TALKING = 0.04;
const CLOSE_MS = 5000;
/** Events main needs: the transcript, hand-offs, and the end of the session. */
const FOR_MAIN = new Set(["session.input_transcript.delta", "session.output_transcript.delta", "session.delegation.created", "session.closed"]);

const calls = createStore<VoiceCallView | undefined>(undefined);
export const useVoiceCall = () => useStore(calls, (call) => call);

interface Connection {
  id: string;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  mic: MediaStream;
  audio: HTMLAudioElement;
  context: AudioContext;
  micLevel: AnalyserNode;
  outLevel?: AnalyserNode;
  timer: ReturnType<typeof setInterval>;
  offMain: () => void;
  closed?: () => void;
}

let connection: Connection | undefined;

const update = (change: (call: VoiceCallView) => VoiceCallView) => calls.set((call) => (call ? change(call) : call));

/** Adds a transcript fragment to the screen: the same speaker's line grows, another speaker starts one. */
function addWords(kind: "user" | "assistant", delta: string): void {
  update((call) => {
    const last = call.lines.at(-1);
    const lines = last?.kind === kind ? [...call.lines.slice(0, -1), { kind, text: last.text + delta }] : [...call.lines, { kind, text: delta.trimStart() }];
    return { ...call, lines: lines.slice(-LINES) };
  });
}

const addLine = (line: CallLine) => update((call) => ({ ...call, lines: [...call.lines, line].slice(-LINES) }));

function level(analyser: AnalyserNode | undefined): number {
  if (!analyser) return 0;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const sample of data) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / data.length) * 4);
}

/** The orb's level now: the voice while it speaks, the microphone while you do. */
export function orbLevel(): number {
  const call = calls.get();
  if (!connection || !call) return 0;
  return call.state === "speaking" ? level(connection.outLevel) : call.state === "hearing" ? level(connection.micLevel) : 0;
}

function onLive(id: string, event: LiveEvent): void {
  if (connection?.id !== id) return;
  if (FOR_MAIN.has(event.type)) window.studio.voice.event(id, event);
  switch (event.type) {
    case "session.started":
      return update((call) => ({ ...call, state: "listening" }));
    case "session.input_transcript.delta":
      return addWords("user", String(event.delta ?? ""));
    case "session.output_transcript.delta":
      return addWords("assistant", String(event.delta ?? ""));
    case "error": {
      const message = String((event.error as { message?: unknown } | undefined)?.message ?? "GPT-Live reported an error");
      return addLine({ kind: "error", text: message });
    }
    case "session.closed":
      connection.closed?.();
      return finish("ended");
  }
}

function onMain(id: string, event: CallEvent): void {
  if (connection?.id !== id) return;
  if (event.type === "send") {
    if (connection.channel.readyState === "open") connection.channel.send(JSON.stringify(event.event));
  } else if (event.type === "work") {
    update((call) => {
      const working = Math.max(0, call.working + (event.done ? -1 : 1));
      const lines = event.done
        ? call.lines.map((line) => (line.work === event.id ? { kind: "work" as const, text: "Checked with your chats" } : line))
        : [...call.lines, { kind: "work" as const, text: "Checking with your chats…", work: event.id }].slice(-LINES);
      return { ...call, working, lines, state: call.state === "listening" && working ? "thinking" : call.state };
    });
  } else if (event.type === "error") addLine({ kind: "error", text: event.message });
}

/** Who is talking, from the audio levels, ten times a second. */
function watch(): void {
  const call = calls.get();
  if (!connection || !call || call.state === "connecting" || call.state === "ended") return;
  const out = !call.assistantMuted && level(connection.outLevel) > OUT_TALKING;
  const mic = !call.micMuted && level(connection.micLevel) > MIC_TALKING;
  const state: CallState = out ? "speaking" : mic ? "hearing" : call.working ? "thinking" : "listening";
  if (state !== call.state) update((current) => ({ ...current, state }));
}

function release(): void {
  const current = connection;
  connection = undefined;
  if (!current) return;
  clearInterval(current.timer);
  current.offMain();
  for (const track of current.mic.getTracks()) track.stop();
  current.channel.close();
  current.peer.close();
  current.audio.srcObject = null;
  void current.context.close();
}

function finish(reason: string): void {
  const id = connection?.id;
  release();
  if (id) window.studio.voice.end(id);
  update((call) => ({ ...call, state: "ended", ended: reason, working: 0 }));
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Starts a call about `cwd`'s project, ending one going on. */
export async function startCall(cwd: string): Promise<void> {
  endCall();
  const id = `call-${Date.now().toString(36)}`;
  calls.set(() => ({ id, cwd, state: "connecting", micMuted: false, assistantMuted: false, working: 0, lines: [] }));
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (calls.get()?.id !== id) return void mic.getTracks().forEach((track) => track.stop());
    const peer = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    const context = new AudioContext();
    const micLevel = context.createAnalyser();
    micLevel.fftSize = 512;
    context.createMediaStreamSource(mic).connect(micLevel);
    for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);
    // The data channel is made before the offer, so the offer carries it.
    const channel = peer.createDataChannel("oai-events");
    const current: Connection = { id, peer, channel, mic, audio, context, micLevel, timer: setInterval(watch, 100), offMain: window.studio.voice.onEvent(onMain) };
    connection = current;
    peer.addEventListener("track", (event) => {
      const stream = new MediaStream([event.track]);
      audio.srcObject = stream;
      void audio.play().catch(() => undefined);
      const out = context.createAnalyser();
      out.fftSize = 512;
      context.createMediaStreamSource(stream).connect(out);
      current.outLevel = out;
    });
    channel.addEventListener("message", ({ data }) => {
      try {
        onLive(id, JSON.parse(String(data)) as LiveEvent);
      } catch {
        // Not JSON: nothing to do with it.
      }
    });
    channel.addEventListener("close", () => connection?.id === id && calls.get()?.state !== "ended" && finish("The call was cut off."));
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" && connection?.id === id) finish("The connection failed.");
    });
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise<void>((resolve, reject) => {
      if (peer.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(() => reject(new Error("the connection could not be prepared in time")), 10_000);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState !== "complete") return;
        clearTimeout(timer);
        resolve();
      });
    });
    const offer = peer.localDescription?.sdp;
    if (!offer) throw new Error("no connection offer");
    const answer = await window.studio.voice.start(id, cwd, offer);
    if (connection?.id !== id) return;
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (error) {
    if (calls.get()?.id !== id) return;
    const message = failure(error);
    release();
    window.studio.voice.end(id);
    calls.set((call) => call && { ...call, state: "ended", ended: message, lines: [...call.lines, { kind: "error", text: message }] });
  }
}

/** Ends the call: GPT-Live is asked to close (for its final usage), then everything is let go. */
export function endCall(): void {
  const call = calls.get();
  const current = connection;
  if (current && call?.state !== "ended" && current.channel.readyState === "open") {
    const timer = setTimeout(() => connection === current && finish("ended"), CLOSE_MS);
    current.closed = () => clearTimeout(timer);
    current.channel.send(JSON.stringify({ type: "session.close" }));
    calls.set(() => undefined);
    return;
  }
  if (current) finish("ended");
  calls.set(() => undefined);
}

export function toggleMic(): void {
  const call = calls.get();
  if (!call || !connection) return;
  const micMuted = !call.micMuted;
  for (const track of connection.mic.getAudioTracks()) track.enabled = !micMuted;
  update((current) => ({ ...current, micMuted }));
}

export function toggleAssistant(): void {
  const call = calls.get();
  if (!call || !connection) return;
  const assistantMuted = !call.assistantMuted;
  connection.audio.muted = assistantMuted;
  update((current) => ({ ...current, assistantMuted }));
}

/** Whether calls can start, from main, kept current. */
export function useVoiceStatus(on: boolean): VoiceStatus | undefined {
  const [status, setStatus] = useState<VoiceStatus>();
  useEffect(() => {
    if (!on) return setStatus(undefined);
    let alive = true;
    void window.studio.voice.status().then((next) => alive && setStatus(next));
    const off = window.studio.voice.onStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, [on]);
  return status;
}
