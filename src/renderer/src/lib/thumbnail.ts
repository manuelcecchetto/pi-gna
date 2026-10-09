// Message and tool-result images show as small thumbnails, but a screenshot is a megabyte or more of base64: as an `<img>`
// each thumbnail kept its data URL in the DOM (a second copy of the base64) and decoded at full size whenever it was drawn
// again. Each image is instead decoded once, straight to its box at the screen's pixel ratio (createImageBitmap's resize,
// off the main thread), encoded small, and shown from a blob URL cached by its URL or a SHA-256 of its bytes. The
// lightbox keeps opening the original (imageSrc).
import { useEffect, useState } from "react";
import { imageSrc } from "./image-src";

export type ThumbImage = { mimeType: string; data: string; url?: string };

/**
 * The CSS box a thumbnail shows in, in px at the largest text size (20 px, where rem sizes are biggest): at most
 * `width`×`height` (`object-contain`); with `cover`, `height` tall and up to `width` wide (`object-cover` crops the rest).
 */
export interface ThumbBox {
  width: number;
  height: number;
  cover?: boolean;
}

/** Below this many base64 characters (~48 KB) the original decodes cheaply: it shows as it is. */
export const MIN_THUMB_CHARS = 64 * 1024;
/** Thumbnails kept; past it the oldest is revoked (~100 KB each). */
export const CACHE_LIMIT = 300;
/** Thumbnails made at once (each decodes a full-size image): two show a screenful soonest (measured against one and three). */
const PARALLEL = 2;

/** The factor that draws a `width`×`height` image sharp in `box` at `dpr` device pixels per CSS pixel; never above 1. */
export function thumbScale(width: number, height: number, box: ThumbBox, dpr: number): number {
  if (width <= 0 || height <= 0) return 1;
  return Math.min(1, box.cover ? 1 : (box.width * dpr) / width, (box.height * dpr) / height);
}

/** Big- and little-endian numbers and text at byte offsets of `bytes` (0 past the end). */
function reader(bytes: Uint8Array) {
  const at = (i: number) => bytes[i] ?? 0;
  return {
    length: bytes.length,
    at,
    be16: (i: number) => (at(i) << 8) | at(i + 1),
    be32: (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0,
    le16: (i: number) => at(i) | (at(i + 1) << 8),
    le24: (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16),
    le32: (i: number) => (at(i) | (at(i + 1) << 8) | (at(i + 2) << 16) | (at(i + 3) << 24)) >>> 0,
    text: (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n)),
  };
}

/** The header bytes an image's size is read from: a JPEG's frame header can follow up to 64 KB of metadata. */
export const HEAD_BYTES = 64 * 1024;

/** The first `bytes` bytes of base64 `data`. */
function headOf(data: string, bytes: number): Uint8Array {
  const binary = atob(data.slice(0, Math.ceil(bytes / 3) * 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JPEG start-of-frame markers (baseline, extended, progressive, lossless and their arithmetic-coded forms). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Whether a JPEG's Exif orientation (in the APP1 segment at `at`) turns it a quarter, swapping width and height. */
function exifTurns(b: ReturnType<typeof reader>, at: number): boolean {
  if (b.text(at + 4, 6) !== "Exif\0\0") return false;
  const tiff = at + 10;
  const little = b.text(tiff, 2) === "II";
  const u16 = (i: number) => (little ? b.le16(i) : b.be16(i));
  const ifd = tiff + (little ? b.le32(tiff + 4) : b.be32(tiff + 4));
  for (let entry = 0, count = u16(ifd); entry < count; entry++) {
    const tag = ifd + 2 + entry * 12;
    if (u16(tag) === 0x0112) return u16(tag + 8) >= 5 && u16(tag + 8) <= 8;
  }
  return false;
}

/** The pixel size of the PNG, JPEG (as its Exif orientation shows it), GIF or WebP whose first bytes are `bytes`. */
export function sizeOf(bytes: Uint8Array): { width: number; height: number } | undefined {
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  const b = reader(bytes);
  if (b.text(0, 8) === "\x89PNG\r\n\x1a\n") return size(b.be32(16), b.be32(20));
  if (b.text(0, 3) === "GIF") return size(b.le16(6), b.le16(8));
  if (b.text(0, 4) === "RIFF" && b.text(8, 4) === "WEBP") {
    const kind = b.text(12, 4);
    if (kind === "VP8X") return size(b.le24(24) + 1, b.le24(27) + 1);
    if (kind === "VP8L") return size((b.le32(21) & 0x3fff) + 1, ((b.le32(21) >>> 14) & 0x3fff) + 1);
    if (kind === "VP8 ") return size(b.le16(26) & 0x3fff, b.le16(28) & 0x3fff);
  }
  if (b.be16(0) !== 0xffd8) return undefined;
  let turned = false;
  for (let at = 2; at + 9 <= b.length; ) {
    if (b.at(at) !== 0xff) return undefined;
    const marker = b.at(at + 1);
    if (marker === 0xff) at++;
    else if (SOF.has(marker)) return turned ? size(b.be16(at + 5), b.be16(at + 7)) : size(b.be16(at + 7), b.be16(at + 5));
    else {
      if (marker === 0xe1) turned ||= exifTurns(b, at);
      at += 2 + b.be16(at + 2);
    }
  }
  return undefined;
}

/** An image block's pixel size from its header, so its place is sized before it decodes; undefined when only its URL is known. */
export function imageSize(image: ThumbImage): { width: number; height: number } | undefined {
  if (!image.data) return undefined;
  try {
    const start = headOf(image.data, 32);
    return sizeOf(start[0] === 0xff && start[1] === 0xd8 ? headOf(image.data, HEAD_BYTES) : start);
  } catch {
    return undefined; // not base64
  }
}

/** The device-pixel box a thumbnail is drawn for (a cover box only by its height). */
export function boxKey(box: ThumbBox, dpr: number): string {
  return box.cover ? `h${Math.round(box.height * dpr)}` : `${Math.round(box.width * dpr)}x${Math.round(box.height * dpr)}`;
}

// Content keys per image block, so a block seen again is not hashed again: its URL, or a hash of its bytes.
const keys = new WeakMap<object, string | Promise<string>>();

/**
 * What an image is, whichever block carries it: its URL, or a SHA-256 of its bytes (digested off the main thread; it
 * rejects outside a secure context, where there is no crypto.subtle).
 */
export function contentKey(image: ThumbImage): string | Promise<string> {
  let key = keys.get(image);
  if (key === undefined) {
    key = image.url ?? digestKey(image);
    keys.set(image, key);
    if (typeof key !== "string") key.then((done) => keys.set(image, done), () => keys.delete(image));
  }
  return key;
}

async function digestKey(image: ThumbImage): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", base64Bytes(image.data)));
  return `${image.mimeType}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Finished thumbnails, oldest first: a blob URL, the original's URL, or "" when the image could not be read (the original
// shows; its data URL is not kept here). And jobs under way.
const done = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function remember(key: string, src: string): void {
  done.set(key, src);
  for (const [oldest, url] of done) {
    if (done.size <= CACHE_LIMIT) break;
    done.delete(oldest);
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (native) return native(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function imageBlob(image: ThumbImage): Promise<Blob> {
  if (image.url) return (await fetch(image.url)).blob();
  return new Blob([base64Bytes(image.data)], { type: image.mimeType });
}

/** Whether every pixel of `pixels` (RGBA) is opaque. */
export function opaque(pixels: Uint8ClampedArray): boolean {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return false;
  return true;
}

/**
 * Decodes the image straight to the thumbnail's size (createImageBitmap's resize) and encodes it on a software canvas
 * (drawing the full-size image on a GPU canvas would keep its texture): as JPEG when it is opaque, as screenshots are
 * (a few ms), else as WebP, which keeps the transparency but takes ~40 ms. An image already small enough, or of a size
 * that cannot be read, shows as it is.
 */
async function makeThumb(image: ThumbImage, box: ThumbBox, dpr: number): Promise<string> {
  const blob = await imageBlob(image);
  const natural = imageSize(image) ?? sizeOf(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer()));
  const scale = natural ? thumbScale(natural.width, natural.height, box, dpr) : 1;
  if (!natural || scale >= 1) return image.url ?? URL.createObjectURL(blob);
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no canvas");
    context.drawImage(bitmap, 0, 0, width, height); // the bitmap is full size where the resize options are not supported
    const type = opaque(context.getImageData(0, 0, width, height).data) ? "image/jpeg" : "image/webp";
    return URL.createObjectURL(await canvas.convertToBlob({ type, quality: 0.85 }));
  } finally {
    bitmap.close();
  }
}

/** How far an image's place is from the middle of the screen, in px: the closest is made first. */
export type Distance = () => number;

// A small queue, so a screenful of screenshots does not decode all at once. Requests made together are ordered before
// any starts: the one closest to the middle of the screen first, the newest among equals.
const queue: Array<{ run: () => void; distance: Distance }> = [];
let running = 0;
let draining = false;

function drain(): void {
  while (running < PARALLEL && queue.length) {
    let best = queue.length - 1;
    let closest = Infinity;
    for (let i = queue.length - 1; i >= 0; i--) {
      const distance = queue[i]!.distance();
      if (distance < closest) [best, closest] = [i, distance];
    }
    queue.splice(best, 1)[0]!.run();
  }
}

function schedule<T>(job: () => Promise<T>, distance: Distance): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          drain();
        });
    };
    queue.push({ run, distance });
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      draining = false;
      drain();
    });
  });
}

/** The thumbnail of `image` for `box`, made once per content and size; the original's src when it cannot be made. */
export async function thumbnail(image: ThumbImage, box: ThumbBox, dpr: number, distance: Distance = () => 0): Promise<string> {
  const content = await Promise.resolve(contentKey(image)).catch(() => undefined);
  if (content === undefined) return imageSrc(image);
  const key = `${content}@${boxKey(box, dpr)}`;
  let job = pending.get(key);
  if (!job && !done.has(key)) {
    job = schedule(() => makeThumb(image, box, dpr), distance).catch(() => "");
    pending.set(key, job);
    void job.then((src) => {
      pending.delete(key);
      remember(key, src);
    });
  }
  return (job ? await job : done.get(key)) || imageSrc(image);
}

/** A finished thumbnail, without waiting (or hashing an image not seen yet). */
export function readyThumbnail(image: ThumbImage, box: ThumbBox, dpr: number): string | undefined {
  const content = keys.get(image);
  const src = typeof content === "string" ? done.get(`${content}@${boxKey(box, dpr)}`) : undefined;
  return src === "" ? imageSrc(image) : src;
}

/** Whether `image` shows as it is: small enough to decode cheaply. */
export const showsAsIs = (image: ThumbImage): boolean => !image.url && image.data.length < MIN_THUMB_CHARS;

/**
 * The `src` for `image` in `box`: the original when it is small, else its thumbnail, made once `near` (until then, and
 * while it is made, `undefined`: show a placeholder, as the original would decode at full size).
 */
export function useThumbnail(image: ThumbImage, box: ThumbBox, near: boolean, distance?: Distance): string | undefined {
  const asIs = showsAsIs(image);
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const [made, setMade] = useState<{ image: ThumbImage; key: string; src: string }>();
  const ready = asIs ? undefined : readyThumbnail(image, box, dpr);
  const size = boxKey(box, dpr);
  useEffect(() => {
    if (asIs || ready || !near) return;
    let live = true;
    void thumbnail(image, box, dpr, distance).then((src) => live && setMade({ image, key: size, src }));
    return () => {
      live = false;
    };
    // `size` stands for the box and pixel ratio.
  }, [image, size, asIs, ready, near]);
  if (asIs) return imageSrc(image);
  return ready ?? (made?.image === image && made.key === size ? made.src : undefined);
}
