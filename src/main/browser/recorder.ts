// Video recording of a browser tab (browser_record). Chromium's screencast (Page.startScreencast) sends a JPEG per
// frame the page draws; a hidden encoder page paints them on a canvas, draws the agent's pointer and clicks over them,
// and encodes the canvas with MediaRecorder (MP4/H.264 where Chromium can, else WebM). Electron dropped the tab capture
// path (getMediaSourceId + chromeMediaSource "tab"), and a screencast keeps working for a tab nobody sees, held in the
// keeper. A tab has one screencast per debugger session: a web tab's is the one RemoteBrowser runs for the phones, which
// the recording joins as a viewer; the agent's copy of a preview gets its own (`screencastSource`). It survives
// navigations; a debugger detach ends it, and both restart it.
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { BrowserWindow, type WebContents } from "electron";
import { withVideoExtension } from "../../shared/browser";
import { log } from "../log";
import { cdp } from "./cdp";

/** A recording stops by itself after this long, or once the video passes RECORD_MAX_BYTES. */
export const RECORD_MAX_MS = 10 * 60_000;
const RECORD_MAX_BYTES = 500 * 1024 * 1024;

export interface RecordingResult {
  file: string;
  mimeType: string;
  bytes: number;
  durationMs: number;
  width: number;
  height: number;
  frames: number;
  /** Why it stopped before the agent asked: the time or size limit, or the tab closing. */
  reason?: string;
}

/**
 * The encoder page's script. Frames come in as base64 JPEG with the page's CSS width (to place the pointer, which
 * comes in CSS pixels); `stop` waits until the last paint reached the stream, so a page that sat still at the end
 * still lasts until the stop; `chunk` hands the video out in pieces small enough for executeJavaScript.
 */
const ENCODER = String.raw`(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  // lucide MousePointer2, the agent's pointer.
  const POINTER = new Path2D("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z");
  let recorder = null, started = null, stopped = null, frame = null, scale = 1, pointer = null, ring = null, ringTimer = 0;
  let bytes = 0, full = false;
  const chunks = [];
  const paint = () => {
    if (!frame) return;
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    if (ring) {
      const age = (performance.now() - ring.at) / 450;
      if (age < 1) {
        context.beginPath();
        context.arc(ring.x * scale, ring.y * scale, (8 + 18 * age) * scale, 0, Math.PI * 2);
        context.strokeStyle = "rgba(59,130,246," + 0.9 * (1 - age) + ")";
        context.lineWidth = 3 * scale;
        context.stroke();
      }
    }
    if (pointer) {
      const s = (20 / 24) * scale;
      context.save();
      context.translate(pointer.x * scale - 4 * s, pointer.y * scale - 4 * s);
      context.scale(s, s);
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.fillStyle = "#fff";
      context.strokeStyle = "#2563eb";
      context.shadowColor = "rgba(0,0,0,0.3)";
      context.shadowBlur = 2;
      context.fill(POINTER);
      context.shadowColor = "transparent";
      context.stroke(POINTER);
      context.restore();
    }
  };
  window.__pignaRecorder = {
    async frame(base64, cssWidth) {
      if (full) return false;
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([data], { type: "image/jpeg" }));
      if (!recorder) {
        // H.264 wants even sizes.
        canvas.width = bitmap.width - (bitmap.width % 2);
        canvas.height = bitmap.height - (bitmap.height % 2);
        const mimeType = ["video/mp4;codecs=avc1.640033", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        const bitsPerSecond = Math.min(20e6, Math.max(2.5e6, canvas.width * canvas.height * 30 * 0.07));
        recorder = new MediaRecorder(canvas.captureStream(30), { mimeType, videoBitsPerSecond: bitsPerSecond });
        started = new Promise((resolve, reject) => { recorder.onstart = resolve; recorder.onerror = (event) => reject(event.error); });
        stopped = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return;
          chunks.push(event.data);
          bytes += event.data.size;
          if (bytes > ${RECORD_MAX_BYTES} && !full) {
            full = true;
            recorder.stop();
          }
        };
        recorder.start(1000);
      }
      // A frame of another size (a resized viewport) is scaled into the first one's canvas.
      scale = canvas.width / cssWidth;
      frame?.close();
      frame = bitmap;
      paint();
      await started;
      return true;
    },
    pointer(x, y, click) {
      pointer = { x, y };
      if (click) {
        ring = { x, y, at: performance.now() };
        clearInterval(ringTimer);
        ringTimer = setInterval(() => {
          paint();
          if (performance.now() - ring.at > 450) { ring = null; clearInterval(ringTimer); paint(); }
        }, 33);
      }
      paint();
    },
    full: () => full,
    async stop() {
      if (!recorder) return { mimeType: "", count: 0, bytes: 0, width: 0, height: 0 };
      if (recorder.state !== "inactive") {
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = recorder.stream;
        const next = () => Promise.race([new Promise((resolve) => video.requestVideoFrameCallback(resolve)), stopped, new Promise((resolve) => setTimeout(resolve, 1000))]);
        const first = next();
        void video.play().catch(() => {});
        await first;
        if (recorder.state !== "inactive") {
          const delivered = next();
          recorder.stream.getVideoTracks()[0].requestFrame();
          paint();
          await delivered;
        }
        video.pause();
        video.srcObject = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      await stopped;
      clearInterval(ringTimer);
      return { mimeType: recorder.mimeType, count: chunks.length, bytes, width: canvas.width, height: canvas.height };
    },
    async chunk(index) {
      const data = new Uint8Array(await chunks[index].arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
      return btoa(binary);
    },
  };
})()`;

/** Where a recording's frames come from: base64 JPEG and the page's CSS width. `start` resolves to a stop function. */
export interface FrameSource {
  start(onFrame: (base64: string, cssWidth: number) => void): Promise<() => void>;
}

/** Frames of the shared screencast a web tab has for the phones watching it (RemoteBrowser), at recording quality. */
export const RECORDING_FRAMES = { maxWidth: 1920, maxHeight: 1920, quality: 85, everyNthFrame: 1, fps: 60 };

/**
 * A screencast of its own, for the agent's copy of a file preview (no phone watches that page). Page.enable first, or
 * a page held in the keeper sends next to no frames; a page that painted before the start sends none until it changes,
 * so the first frame is a screenshot. A debugger detach ends a screencast: it is started again.
 */
export function screencastSource(wc: WebContents): FrameSource {
  return {
    async start(onFrame) {
      let first = true;
      const onMessage = (_event: unknown, method: string, params: { data: string; sessionId: number; metadata: { deviceWidth: number } }) => {
        if (method !== "Page.screencastFrame") return;
        first = false;
        void cdp(wc, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
        onFrame(params.data, Number(params.metadata.deviceWidth) || 1);
      };
      const cast = async () => {
        await cdp(wc, "Page.enable");
        await cdp(wc, "Page.startScreencast", { format: "jpeg", quality: RECORDING_FRAMES.quality, maxWidth: RECORDING_FRAMES.maxWidth, maxHeight: RECORDING_FRAMES.maxHeight, everyNthFrame: 1 });
      };
      let restart: ReturnType<typeof setTimeout> | undefined;
      const onDetach = () => {
        clearTimeout(restart);
        restart = setTimeout(() => void cast().catch(() => undefined), 300);
      };
      wc.debugger.on("message", onMessage);
      wc.debugger.on("detach", onDetach);
      await cast();
      const shot = (await cdp(wc, "Page.captureScreenshot", { format: "jpeg", quality: RECORDING_FRAMES.quality }).catch(() => undefined)) as { data: string } | undefined;
      const width = (await wc.executeJavaScript("innerWidth").catch(() => 0)) as number;
      if (shot && first) onFrame(shot.data, width || 1);
      return () => {
        clearTimeout(restart);
        wc.debugger.off("message", onMessage);
        wc.debugger.off("detach", onDetach);
        if (!wc.isDestroyed() && wc.debugger.isAttached()) void cdp(wc, "Page.stopScreencast").catch(() => undefined);
      };
    },
  };
}

export class Recording {
  readonly startedAt = Date.now();
  frames = 0;
  private encoder?: BrowserWindow;
  private limit?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<RecordingResult>;
  private stopSource?: () => void;
  /** The encoder takes one frame at a time; meanwhile only the newest waits, older ones are dropped. */
  private busy = false;
  private waiting?: { base64: string; cssWidth: number };

  /** `onFull`: the time or size limit was reached; the owner stops the recording. */
  constructor(
    private readonly source: FrameSource,
    private readonly onFull: () => void,
  ) {}

  async start(): Promise<void> {
    const encoder = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.encoder = encoder;
    try {
      await encoder.loadURL("about:blank");
      await encoder.webContents.executeJavaScript(ENCODER);
      this.stopSource = await this.source.start((base64, cssWidth) => this.push(base64, cssWidth));
    } catch (error) {
      encoder.destroy();
      throw error;
    }
    this.limit = setTimeout(this.onFull, RECORD_MAX_MS);
  }

  private push(base64: string, cssWidth: number): void {
    this.frames++;
    if (this.busy) {
      this.waiting = { base64, cssWidth };
      return;
    }
    const encoder = this.encoder;
    if (!encoder || encoder.isDestroyed() || this.stopping) return;
    this.busy = true;
    void encoder.webContents
      .executeJavaScript(`__pignaRecorder.frame(${JSON.stringify(base64)}, ${Number(cssWidth) || 1})`)
      .then((taken: boolean) => {
        if (taken === false) this.onFull();
      })
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
        const next = this.waiting;
        this.waiting = undefined;
        if (next) {
          this.frames--;
          this.push(next.base64, next.cssWidth);
        }
      });
  }

  /** Draw the agent's pointer at a point of the page (CSS px), with a click ring when `click`. */
  pointer(x: number, y: number, click: boolean): void {
    const encoder = this.encoder;
    if (!encoder || encoder.isDestroyed()) return;
    void encoder.webContents.executeJavaScript(`__pignaRecorder.pointer(${Number(x)}, ${Number(y)}, ${click})`).catch(() => undefined);
  }

  /** Stop and write the video to `file` (its extension follows the format); the same promise for every caller. */
  stop(file: string, reason?: string): Promise<RecordingResult> {
    this.stopping ??= this.finish(file, reason);
    return this.stopping;
  }

  private async finish(file: string, reason: string | undefined): Promise<RecordingResult> {
    clearTimeout(this.limit);
    this.stopSource?.();
    const encoder = this.encoder;
    if (!encoder || encoder.isDestroyed()) throw new Error("The recording's encoder is gone.");
    try {
      // The frame being encoded finishes first.
      for (let i = 0; i < 50 && this.busy; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const info = (await encoder.webContents.executeJavaScript("__pignaRecorder.stop()")) as { mimeType: string; count: number; bytes: number; width: number; height: number };
      if (!info.count) throw new Error("Nothing was recorded: the page drew no frame while recording.");
      const target = withVideoExtension(file, info.mimeType);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, "w");
      try {
        for (let index = 0; index < info.count; index++) {
          const base64 = (await encoder.webContents.executeJavaScript(`__pignaRecorder.chunk(${index})`)) as string;
          await handle.write(Buffer.from(base64, "base64"));
        }
      } finally {
        await handle.close();
      }
      log.info("browser", `recording saved: ${target} (${info.bytes} bytes, ${this.frames} frames${reason ? `, ${reason}` : ""})`);
      return { file: target, mimeType: info.mimeType, bytes: info.bytes, durationMs: Date.now() - this.startedAt, width: info.width, height: info.height, frames: this.frames, reason };
    } finally {
      encoder.destroy();
    }
  }
}
