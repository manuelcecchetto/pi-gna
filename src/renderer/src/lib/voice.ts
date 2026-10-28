// Voice calls' audio in the window (src/shared/voice.ts): the microphone streams to main as 16 kHz mono PCM, and the
// speech main sends back plays sentence by sentence, each starting once it will not run dry (readyToPlay).

import { useEffect, useState } from "react";
import { INPUT_RATE, level, MAX_CHUNK, OUTPUT_RATE, readyToPlay, type VoiceStatus } from "../../../shared/voice";

/** The microphone, as 16 kHz mono chunks of about 128 ms. */
export class MicStream {
  muted = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly processor: ScriptProcessorNode,
  ) {}

  /** `onLevel` gets each chunk's level in dBFS, also while muted (the orb shows it). */
  static async start(onChunk: (pcm: Float32Array) => void, onLevel: (db: number) => void): Promise<MicStream> {
    // Echo cancellation keeps the assistant's own voice from the speakers out of what main hears.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const context = new AudioContext({ sampleRate: INPUT_RATE });
    const source = context.createMediaStreamSource(stream);
    // A ScriptProcessor, not an AudioWorklet: a worklet's module would need a script URL the page's CSP allows.
    const processor = context.createScriptProcessor(2048, 1, 1);
    const mic = new MicStream(stream, context, processor);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm = context.sampleRate === INPUT_RATE ? new Float32Array(input) : resample(input, context.sampleRate, INPUT_RATE);
      onLevel(level(pcm));
      if (!mic.muted) for (let at = 0; at < pcm.length; at += MAX_CHUNK) onChunk(pcm.slice(at, at + MAX_CHUNK));
    };
    source.connect(processor);
    // A processor runs only while connected onward; it writes no output, so this plays silence.
    processor.connect(context.destination);
    return mic;
  }

  stop(): void {
    this.processor.onaudioprocess = null;
    this.processor.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    void this.context.close();
  }
}

/** Linear resampling, for a computer whose audio will not run at 16 kHz. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((input.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const at = (i * from) / to;
    const low = Math.floor(at);
    const high = Math.min(low + 1, input.length - 1);
    out[i] = (input[low] ?? 0) + ((input[high] ?? 0) - (input[low] ?? 0)) * (at - low);
  }
  return out;
}

interface Utterance {
  id: number;
  expected: number;
  chunks: Float32Array[];
  received: number;
  firstAt: number;
  done: boolean;
  started: boolean;
}

/** Plays the call's speech: sentences in order, each when it can play through, gaplessly within a sentence. */
export class SpeechPlayer {
  private readonly context = new AudioContext({ sampleRate: OUTPUT_RATE });
  private readonly queue: Utterance[] = [];
  private readonly sources = new Set<AudioBufferSourceNode>();
  private end = 0;
  private playing = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** The output's level now, for the orb. */
  readonly analyser: AnalyserNode;

  constructor(private readonly onPlaying: (playing: boolean) => void) {
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.context.destination);
  }

  begin(id: number, expected: number): void {
    this.queue.push({ id, expected, chunks: [], received: 0, firstAt: 0, done: false, started: false });
  }

  push(id: number, pcm: Float32Array): void {
    const utterance = this.queue.find((candidate) => candidate.id === id);
    if (!utterance) return;
    if (!utterance.firstAt) utterance.firstAt = performance.now();
    utterance.chunks.push(pcm);
    utterance.received += pcm.length / OUTPUT_RATE;
    this.pump();
  }

  finish(id: number): void {
    const utterance = this.queue.find((candidate) => candidate.id === id);
    if (!utterance) return;
    utterance.done = true;
    this.pump();
  }

  /** Drops everything not yet played, and what is playing. */
  flush(): void {
    clearTimeout(this.retry);
    this.queue.length = 0;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    this.sources.clear();
    this.end = 0;
    this.setPlaying(false);
  }

  private pump(): void {
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      if (!head.started) {
        const seconds = (performance.now() - head.firstAt) / 1000;
        // Measured once a little audio came; until then assume a slow computer.
        const rate = seconds > 0.3 ? head.received / seconds : 0.6;
        // What still plays of earlier sentences is a cushion too.
        const cushion = Math.max(0, this.end - this.context.currentTime);
        if (!readyToPlay(head.received + cushion, head.expected + cushion, rate, head.done)) {
          clearTimeout(this.retry);
          if (!head.done) this.retry = setTimeout(() => this.pump(), 100);
          return;
        }
        head.started = true;
      }
      for (const chunk of head.chunks.splice(0)) this.schedule(chunk);
      if (!head.done) return;
      this.queue.shift();
    }
  }

  private schedule(pcm: Float32Array): void {
    if (!pcm.length) return;
    void this.context.resume();
    const buffer = this.context.createBuffer(1, pcm.length, OUTPUT_RATE);
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const at = Math.max(this.context.currentTime + 0.03, this.end);
    source.start(at);
    this.end = at + buffer.duration;
    this.sources.add(source);
    this.setPlaying(true);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size && !this.queue.some((utterance) => utterance.started || utterance.chunks.length)) this.setPlaying(false);
    };
  }

  private setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.onPlaying(playing);
  }

  /** The output's level, 0..1. */
  outputLevel(): number {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }

  close(): void {
    this.flush();
    void this.context.close();
  }
}

/** The voice model's status from main, kept current. */
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
