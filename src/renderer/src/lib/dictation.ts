// Dictation's renderer side (src/shared/dictation.ts): records the microphone and hands main 16 kHz mono PCM, and
// reads the Right Option key: a tap starts or stops a recording, holding it records until it is let go.

import { useEffect, useState } from "react";
import { type DictationStatus, SAMPLE_RATE } from "../../../shared/dictation";

/** One recording from the microphone. MediaRecorder's compressed audio is decoded and resampled to 16 kHz at the end. */
export class Recording {
  private readonly chunks: Blob[] = [];
  private readonly stopped: Promise<void>;

  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
  ) {
    recorder.ondataavailable = (event) => event.data.size && this.chunks.push(event.data);
    this.stopped = new Promise((resolve) => (recorder.onstop = () => resolve()));
    recorder.start();
  }

  static async start(): Promise<Recording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    return new Recording(stream, new MediaRecorder(stream));
  }

  private async end(): Promise<void> {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    for (const track of this.stream.getTracks()) track.stop();
    await this.stopped;
  }

  /** Stops and returns the audio as 16 kHz mono samples (empty when nothing was recorded). */
  async finish(): Promise<Float32Array> {
    await this.end();
    if (!this.chunks.length) return new Float32Array();
    const encoded = await new Blob(this.chunks, { type: this.recorder.mimeType }).arrayBuffer();
    // decodeAudioData resamples to the context's rate.
    const audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(encoded);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel);
      for (let i = 0; i < data.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / audio.numberOfChannels;
    }
    return mono;
  }

  /** Stops and drops the audio. */
  cancel(): void {
    void this.end();
  }
}

/** Held longer than this, Right Option records until it is let go; a shorter tap toggles. */
export const HOLD_MS = 250;

export type KeyAction = "start" | "stop" | "cancel";

/**
 * Right Option alone dictates; with another key it is the usual modifier (⌥← moves by word, ⌥e types é, AltGr types
 * [ on an Italian keyboard), so any other key pressed while it is down calls the gesture off. A tap starts a recording,
 * or stops the one going on; held for HOLD_MS it starts one that stops when the key comes up.
 */
export class RightOptionGesture {
  private down = false;
  private other = false;
  private holding = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly act: (action: KeyAction) => void,
    private readonly recording: () => boolean,
  ) {}

  keydown(event: Pick<KeyboardEvent, "code" | "repeat">): void {
    if (event.code !== "AltRight") {
      if (!this.down) return;
      this.other = true;
      clearTimeout(this.timer);
      if (this.holding) {
        this.holding = false;
        this.act("cancel");
      }
      return;
    }
    if (event.repeat || this.down) return;
    this.down = true;
    this.other = false;
    if (this.recording()) return;
    this.timer = setTimeout(() => {
      if (!this.down || this.other || this.recording()) return;
      this.holding = true;
      this.act("start");
    }, HOLD_MS);
  }

  keyup(event: Pick<KeyboardEvent, "code">): void {
    if (event.code !== "AltRight" || !this.down) return;
    this.down = false;
    clearTimeout(this.timer);
    if (this.other) return;
    if (this.holding) {
      this.holding = false;
      this.act("stop");
    } else this.act(this.recording() ? "stop" : "start");
  }

  /** The window lost focus: the key-up will never come, so a held recording ends here. */
  blur(): void {
    clearTimeout(this.timer);
    this.down = false;
    if (this.holding) {
      this.holding = false;
      this.act("stop");
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Dictation's model status from main, kept current. */
export function useDictationStatus(on: boolean): DictationStatus | undefined {
  const [status, setStatus] = useState<DictationStatus>();
  useEffect(() => {
    if (!on) return setStatus(undefined);
    let alive = true;
    void window.studio.dictation.status().then((next) => alive && setStatus(next));
    const off = window.studio.dictation.onStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, [on]);
  return status;
}
