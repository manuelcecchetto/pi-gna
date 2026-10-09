// The phone's view of the Mac app a chat drives (Computer Use, docs/REMOTE.md section 8): the helper's frame shrunk to
// PREVIEW_WIDTH once per capture, and only its id while it looks like the frame the phone already shows.
import { createHash } from "node:crypto";
import type { NativeImage } from "electron";
import type { ComputerPreviewFrame } from "../../shared/computer";

/** Wide enough for the phone's strip (about 340 CSS px at 3x); the helper captures up to 1600 px. */
export const PREVIEW_WIDTH = 800;
/** Chats whose last frame is kept; a chat past it sends its next frame again. */
const KEPT = 8;
/**
 * Captures of a window that did not change still differ by a few levels per channel (glass materials resample what is
 * behind them: at most 6 measured on Calculator), a change by far more on some pixel.
 */
const NOISE = 16;

/** A shrunk frame: the JPEG (base64) and its pixels, to tell a change from capture noise. */
export interface Small {
  data: string;
  pixels: Buffer;
}

interface Shot {
  mimeType: string;
  data: string;
  app: string;
}

interface Kept {
  raw: string;
  frame: Required<Omit<ComputerPreviewFrame, "app">>;
  pixels?: Buffer;
}

export class ComputerPreviews {
  private readonly last = new Map<string, Kept>();

  constructor(
    private readonly capture: (handle: string) => Promise<Shot | null>,
    /** The frame as a smaller JPEG, or undefined when it cannot: then it goes out as captured. */
    private readonly shrink: (jpeg: string) => Small | undefined,
  ) {}

  async frame(handle: string, since?: string): Promise<ComputerPreviewFrame | null> {
    const shot = await this.capture(handle);
    if (!shot) {
      this.last.delete(handle);
      return null;
    }
    let kept = this.last.get(handle);
    // The same bytes need no decode, resize and encode again; a frame like the last keeps its id.
    if (kept?.raw !== shot.data) {
      const next = this.small(shot);
      kept = kept?.pixels && next.pixels && alike(kept.pixels, next.pixels) ? { ...kept, raw: shot.data } : { raw: shot.data, ...next };
    }
    this.last.delete(handle);
    this.last.set(handle, kept);
    if (this.last.size > KEPT) this.last.delete(this.last.keys().next().value as string);
    const { id, mimeType, data } = kept.frame;
    return id === since ? { id, app: shot.app } : { id, app: shot.app, mimeType, data };
  }

  private small(shot: Shot): Omit<Kept, "raw"> {
    let small: Small | undefined;
    try {
      small = this.shrink(shot.data);
    } catch {
      small = undefined;
    }
    const { mimeType, data } = small ? { mimeType: "image/jpeg", data: small.data } : shot;
    return { frame: { id: createHash("sha1").update(data).digest("base64url").slice(0, 16), mimeType, data }, pixels: small?.pixels };
  }
}

/** Same size, and no channel of any pixel moved by more than NOISE. */
export function alike(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > NOISE) return false;
  return true;
}

/** The shrink step with Electron's nativeImage: JPEG 75 at most PREVIEW_WIDTH wide. */
export const shrinkWith =
  (images: { createFromBuffer(buffer: Buffer): NativeImage }) =>
  (jpeg: string): Small | undefined => {
    const image = images.createFromBuffer(Buffer.from(jpeg, "base64"));
    if (image.isEmpty()) return undefined;
    const fit = image.getSize().width > PREVIEW_WIDTH ? image.resize({ width: PREVIEW_WIDTH, quality: "good" }) : image;
    return { data: fit.toJPEG(75).toString("base64"), pixels: fit.toBitmap() };
  };
