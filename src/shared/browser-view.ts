// Pure helpers for streaming a host browser tab to a remote viewer: what to ask the screencast for, latest-only
// frame delivery, and phone coordinates to page input. No Electron or DOM imports.
import { toInputCoords } from "./viewport";

/** The viewer's screen: CSS px of the area it draws the frame in, and its device pixel ratio. */
export interface ViewerSpec {
  width: number;
  height: number;
  dpr: number;
}

export interface FrameParams {
  maxWidth: number;
  maxHeight: number;
  /** JPEG quality, 1-100. */
  quality: number;
  /** Chromium produces ~60 frames/s; every Nth is sent. */
  everyNthFrame: number;
  /** Cap on frames sent to this viewer per second. */
  fps: number;
}

const MIN_EDGE = 160;
const MAX_EDGE = 1800;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Validates a viewer from query values; unusable numbers fall back to a typical phone. */
export function parseViewer(width: unknown, height: unknown, dpr: unknown): ViewerSpec {
  const num = (value: unknown, fallback: number) => {
    const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { width: clamp(Math.round(num(width, 390)), 100, 4000), height: clamp(Math.round(num(height, 844)), 100, 4000), dpr: clamp(num(dpr, 2), 1, 4) };
}

/**
 * Screencast settings for a viewer: no more pixels than its screen shows, fewer frames and lower quality as the frame
 * grows, so a small phone gets a smooth stream and a big tablet does not saturate the link.
 */
export function frameParams(viewer: ViewerSpec): FrameParams {
  const maxWidth = Math.round(clamp(viewer.width * Math.min(viewer.dpr, 3), MIN_EDGE, MAX_EDGE));
  const maxHeight = Math.round(clamp(viewer.height * Math.min(viewer.dpr, 3), MIN_EDGE, MAX_EDGE));
  const pixels = maxWidth * maxHeight;
  const fps = pixels <= 1_000_000 ? 30 : pixels <= 2_000_000 ? 20 : 12;
  return { maxWidth, maxHeight, quality: pixels <= 1_000_000 ? 60 : 50, everyNthFrame: Math.round(60 / fps), fps };
}

/** Settings for several viewers of one tab (a screencast is per tab): the largest ask wins, the rest throttle on delivery. */
export function mergeFrameParams(all: FrameParams[]): FrameParams | undefined {
  if (!all.length) return undefined;
  return all.reduce((a, b) => ({
    maxWidth: Math.max(a.maxWidth, b.maxWidth),
    maxHeight: Math.max(a.maxHeight, b.maxHeight),
    quality: Math.max(a.quality, b.quality),
    everyNthFrame: Math.min(a.everyNthFrame, b.everyNthFrame),
    fps: Math.max(a.fps, b.fps),
  }));
}

export const sameFrameParams = (a: FrameParams | undefined, b: FrameParams | undefined) =>
  a === b || (!!a && !!b && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight && a.quality === b.quality && a.everyNthFrame === b.everyNthFrame);

/**
 * Latest-frame-only delivery: while a send is in flight (or the fps cap has not elapsed) newer frames replace the waiting
 * one, so a slow link drops frames instead of queueing them and the viewer always gets the freshest.
 */
export class FrameGate<T> {
  private pending?: T;
  private busy = false;
  private lastAt = -Infinity;
  private timer?: unknown;
  private closed = false;
  /** Frames replaced before they were sent. */
  dropped = 0;

  constructor(
    private readonly send: (frame: T) => Promise<void>,
    private readonly fps: number,
    private readonly clock: { now(): number; later(ms: number, run: () => void): unknown; cancel(handle: unknown): void } = {
      now: () => Date.now(),
      later: (ms, run) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  offer(frame: T): void {
    if (this.closed) return;
    if (this.pending !== undefined) this.dropped++;
    this.pending = frame;
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
    if (this.timer !== undefined) this.clock.cancel(this.timer);
  }

  private pump(): void {
    if (this.busy || this.timer !== undefined || this.pending === undefined || this.closed) return;
    const wait = this.lastAt + 1000 / this.fps - this.clock.now();
    if (wait > 0) {
      this.timer = this.clock.later(wait, () => {
        this.timer = undefined;
        this.pump();
      });
      return;
    }
    const frame = this.pending;
    this.pending = undefined;
    this.busy = true;
    this.lastAt = this.clock.now();
    void this.send(frame)
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}

/** A tap at (x, y) CSS px of the streamed page to the view pixels CDP input expects (clamped inside the page). */
export function inputPoint(x: number, y: number, page: { width: number; height: number }, scale: number): { x: number; y: number } {
  const safe = (value: number) => (Number.isFinite(value) ? value : 0);
  return toInputCoords(clamp(safe(x), 0, Math.max(0, page.width - 1)), clamp(safe(y), 0, Math.max(0, page.height - 1)), scale);
}
