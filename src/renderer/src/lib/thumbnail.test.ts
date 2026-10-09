import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxKey, opaque, showsAsIs, sizeOf, thumbScale, type ThumbBox, type ThumbImage } from "./thumbnail";

type Mod = typeof import("./thumbnail");

const RESULT: ThumbBox = { width: 460, height: 280 };
const USER: ThumbBox = { width: 280, height: 120, cover: true };

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 255);
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** A PNG's signature and IHDR; `tag` changes a later byte, so images of one size differ. */
const png = (width: number, height: number, tag = 0) => new Uint8Array([0x89, ...ascii("PNG\r\n\x1a\n"), 0, 0, 0, 13, ...ascii("IHDR"), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, tag & 255, tag >> 8]);
const sof = (width: number, height: number) => [0xff, 0xc0, 0, 17, 8, ...be16(height), ...be16(width), 3];
const app0 = [0xff, 0xe0, 0, 16, ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
/** An Exif APP1 segment with one IFD0 entry: Orientation = `orientation`. */
function exif(orientation: number, little: boolean) {
  const u16 = (n: number) => (little ? le(n, 2) : be16(n));
  const tiff = [...ascii(little ? "II" : "MM"), ...u16(42), ...(little ? le(8, 4) : u32(8)), ...u16(1), ...u16(0x0112), ...u16(3), ...(little ? le(1, 4) : u32(1)), ...u16(orientation), 0, 0, 0, 0, 0, 0];
  const body = [...ascii("Exif\0\0"), ...tiff];
  return [0xff, 0xe1, ...be16(body.length + 2), ...body];
}
const jpeg = (...segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda]);
const gif = (width: number, height: number) => new Uint8Array([...ascii("GIF89a"), ...le(width, 2), ...le(height, 2), 0]);
const riff = (kind: string, body: number[]) => new Uint8Array([...ascii("RIFF"), ...le(100, 4), ...ascii("WEBP"), ...ascii(kind), ...le(body.length, 4), ...body]);

const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const block = (bytes: Uint8Array, mimeType = "image/png"): ThumbImage => ({ type: "image", mimeType, data: base64(bytes) }) as ThumbImage;

describe("thumbScale", () => {
  it("fits both sides of a contain box, at the pixel ratio, and never enlarges", () => {
    expect(thumbScale(2000, 1000, RESULT, 2)).toBeCloseTo(920 / 2000); // the width binds
    expect(thumbScale(2000, 1250, RESULT, 2)).toBeCloseTo(560 / 1250); // the height binds
    expect(thumbScale(2000, 1000, RESULT, 1)).toBeCloseTo(460 / 2000);
    expect(thumbScale(300, 200, RESULT, 2)).toBe(1);
  });

  it("sizes a cover box by its height alone (the width is cropped)", () => {
    expect(thumbScale(3000, 1000, USER, 2)).toBeCloseTo(240 / 1000);
    expect(thumbScale(200, 100, USER, 2)).toBe(1);
  });

  it("leaves an image without a size as it is", () => {
    expect(thumbScale(0, 100, RESULT, 2)).toBe(1);
    expect(thumbScale(100, -1, RESULT, 2)).toBe(1);
  });
});

describe("boxKey", () => {
  it("names the device-pixel box: a cover box by its height only", () => {
    expect(boxKey(RESULT, 2)).toBe("920x560");
    expect(boxKey(RESULT, 1.5)).toBe("690x420");
    expect(boxKey(USER, 2)).toBe("h240");
    expect(boxKey({ ...USER, width: 999 }, 2)).toBe("h240");
  });
});

describe("sizeOf", () => {
  it("reads PNG, GIF and the three WebP kinds", () => {
    expect(sizeOf(png(2000, 1250))).toEqual({ width: 2000, height: 1250 });
    expect(sizeOf(png(70000, 3))).toEqual({ width: 70000, height: 3 });
    expect(sizeOf(png(2 ** 31, 3))).toEqual({ width: 2 ** 31, height: 3 }); // unsigned
    expect(sizeOf(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(sizeOf(riff("VP8X", [0, 0, 0, 0, ...le(1469, 3), ...le(843, 3)]))).toEqual({ width: 1470, height: 844 });
    expect(sizeOf(riff("VP8X", [0, 0, 0, 0, ...le(69999, 3), ...le(2, 3)]))).toEqual({ width: 70000, height: 3 });
    const lossless = 1469 | (843 << 14);
    expect(sizeOf(riff("VP8L", [0x2f, ...le(lossless, 4)]))).toEqual({ width: 1470, height: 844 });
    expect(sizeOf(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le(1470, 2), ...le(844, 2)]))).toEqual({ width: 1470, height: 844 });
    expect(sizeOf(riff("ALPH", [0, 0, 0, 0]))).toBeUndefined();
  });

  it("reads a JPEG's frame header past the segments before it", () => {
    expect(sizeOf(jpeg(app0, sof(1470, 844)))).toEqual({ width: 1470, height: 844 });
    expect(sizeOf(jpeg([0xff, 0xff], app0, [0xff], sof(1470, 844)))).toEqual({ width: 1470, height: 844 }); // fill bytes
    expect(sizeOf(jpeg(app0, [0xff, 0xc2, 0, 17, 8, ...be16(30), ...be16(40), 3]))).toEqual({ width: 40, height: 30 }); // progressive
    expect(sizeOf(jpeg([0x12], sof(1470, 844)))).toBeUndefined(); // a stray byte where a marker belongs
  });

  it("swaps a JPEG's sides when its Exif orientation turns it a quarter, in either byte order", () => {
    for (const little of [false, true]) {
      expect(sizeOf(jpeg(exif(6, little), sof(4032, 3024)))).toEqual({ width: 3024, height: 4032 });
      expect(sizeOf(jpeg(exif(8, little), sof(4032, 3024)))).toEqual({ width: 3024, height: 4032 });
      expect(sizeOf(jpeg(exif(5, little), sof(4032, 3024)))).toEqual({ width: 3024, height: 4032 });
      expect(sizeOf(jpeg(exif(1, little), sof(4032, 3024)))).toEqual({ width: 4032, height: 3024 });
      expect(sizeOf(jpeg(exif(3, little), sof(4032, 3024)))).toEqual({ width: 4032, height: 3024 });
      expect(sizeOf(jpeg(exif(9, little), sof(4032, 3024)))).toEqual({ width: 4032, height: 3024 }); // not an orientation
      expect(sizeOf(jpeg(exif(6, little), app0, sof(4032, 3024)))).toEqual({ width: 3024, height: 4032 }); // later segments keep it
    }
    // Another APP1 (XMP) laid out like Exif is not read as one.
    const xmp = exif(6, false);
    xmp.splice(4, 6, ...ascii("XMP\0\0\0"));
    expect(sizeOf(jpeg(xmp, sof(4032, 3024)))).toEqual({ width: 4032, height: 3024 });
  });

  it("gives up on anything else", () => {
    expect(sizeOf(new Uint8Array(ascii("BM......")))).toBeUndefined();
    expect(sizeOf(new Uint8Array([0, 0, ...sof(400, 300)]))).toBeUndefined(); // a frame header without the JPEG start
    expect(sizeOf(jpeg(app0))).toBeUndefined(); // no frame header
    expect(sizeOf(new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined(); // not a marker
    expect(sizeOf(png(0, 10))).toBeUndefined();
    expect(sizeOf(new Uint8Array())).toBeUndefined();
  });
});

describe("imageSize", () => {
  it("reads the header from the base64, a JPEG's from up to 64 KB in", async () => {
    const { imageSize } = await import("./thumbnail");
    expect(imageSize(block(png(2000, 1250)))).toEqual({ width: 2000, height: 1250 });
    const bigExif = [0xff, 0xe1, ...be16(40_002), ...new Array(40_000).fill(0)];
    expect(imageSize(block(jpeg(app0, bigExif, sof(1470, 844)), "image/jpeg"))).toEqual({ width: 1470, height: 844 });
    expect(imageSize({ mimeType: "image/png", data: "", url: "/api/image/abc" })).toBeUndefined();
    expect(imageSize({ mimeType: "image/png", data: "not base64!" })).toBeUndefined();
  });
});

describe("opaque and showsAsIs", () => {
  it("tells opaque pixels from any transparency", () => {
    expect(opaque(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(true);
    expect(opaque(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(false);
    expect(opaque(new Uint8ClampedArray([255, 255, 255, 0, 4, 5, 6, 255]))).toBe(false);
  });

  it("shows small inline images as they are, never one known by URL", () => {
    expect(showsAsIs({ mimeType: "image/png", data: "A".repeat(64 * 1024 - 1) })).toBe(true);
    expect(showsAsIs({ mimeType: "image/png", data: "A".repeat(64 * 1024) })).toBe(false);
    expect(showsAsIs({ mimeType: "image/png", data: "", url: "/api/image/abc" })).toBe(false);
  });
});

describe("thumbnail", () => {
  let mod: Mod;
  let decodes: Array<{ type: string; options?: ImageBitmapOptions; resolve: () => void }>;
  let encoded: string[];
  let revoked: string[];
  let urls: Map<string, Blob>;
  let alpha: number;
  let hold: boolean;
  let fails: boolean;

  beforeEach(async () => {
    decodes = [];
    encoded = [];
    revoked = [];
    urls = new Map();
    alpha = 255;
    hold = false;
    fails = false;
    let next = 0;
    vi.stubGlobal("createImageBitmap", (blob: Blob, options?: ImageBitmapOptions) => {
      if (fails) return Promise.reject(new Error("bad image"));
      return new Promise((resolve) => {
        const done = () => resolve({ width: options?.resizeWidth ?? 1, height: options?.resizeHeight ?? 1, close: () => {} });
        decodes.push({ type: blob.type, options, resolve: done });
        if (!hold) done();
      });
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return { drawImage: () => {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(alpha) }) };
        }
        convertToBlob({ type }: { type: string }) {
          encoded.push(`${type} ${this.width}x${this.height}`);
          return Promise.resolve(new Blob(["thumb"], { type }));
        }
      },
    );
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      const url = `blob:${++next}`;
      urls.set(url, blob as Blob);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void revoked.push(url));
    vi.stubGlobal("fetch", async (url: string) => {
      const queued = /\/q(\d)$/.exec(url);
      const bytes = queued ? png(4000, 1000 + 100 * Number(queued[1])) : url.endsWith("small") ? png(100, 80) : png(2000, 1250);
      return { blob: async () => new Blob([bytes], { type: "image/png" }) };
    });
    vi.resetModules();
    mod = await import("./thumbnail");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("decodes straight to the box at the pixel ratio and encodes an opaque image as JPEG", async () => {
    const url = await mod.thumbnail(block(png(2000, 1250)), RESULT, 2);
    expect(decodes).toHaveLength(1);
    expect(decodes[0]!.options).toEqual({ resizeWidth: 896, resizeHeight: 560, resizeQuality: "high" });
    expect(encoded).toEqual(["image/jpeg 896x560"]);
    expect(urls.get(url)?.type).toBe("image/jpeg");
  });

  it("keeps transparency as WebP, and sizes a cover box by its height", async () => {
    alpha = 0;
    await mod.thumbnail(block(png(3000, 1000)), USER, 2);
    expect(decodes[0]!.options).toMatchObject({ resizeWidth: 720, resizeHeight: 240 });
    expect(encoded).toEqual(["image/webp 720x240"]);
  });

  it("makes each thumbnail once: callers at the same time share it, later ones and other blocks of the same bytes reuse it", async () => {
    const image = block(png(2000, 1250, 7));
    const [a, b] = await Promise.all([mod.thumbnail(image, RESULT, 2), mod.thumbnail(image, RESULT, 2)]);
    expect(a).toBe(b);
    expect(await mod.thumbnail(image, RESULT, 2)).toBe(a);
    expect(await mod.thumbnail({ ...image }, RESULT, 2)).toBe(a);
    expect(mod.readyThumbnail(image, RESULT, 2)).toBe(a);
    expect(decodes).toHaveLength(1);
    // Another size, or other bytes, is another thumbnail.
    await mod.thumbnail(image, RESULT, 1);
    await mod.thumbnail(block(png(2000, 1250, 8)), RESULT, 2);
    expect(decodes).toHaveLength(3);
  });

  it("is not ready before it is made, nor for a block it has not hashed", async () => {
    const image = block(png(2000, 1250));
    expect(mod.readyThumbnail(image, RESULT, 2)).toBeUndefined();
    await mod.thumbnail(image, RESULT, 2);
    expect(mod.readyThumbnail({ ...image }, RESULT, 2)).toBeUndefined();
    expect(mod.readyThumbnail(image, USER, 2)).toBeUndefined();
  });

  it("shows an image already small enough as it is, from a blob URL rather than its data URL", async () => {
    const url = await mod.thumbnail(block(png(800, 500)), RESULT, 2);
    expect(decodes).toHaveLength(0);
    expect(url).toMatch(/^blob:/);
    expect(urls.get(url)?.type).toBe("image/png");
  });

  it("shows an image of a size it cannot read as it is", async () => {
    const url = await mod.thumbnail(block(new Uint8Array(ascii("BM some bitmap")), "image/bmp"), RESULT, 2);
    expect(decodes).toHaveLength(0);
    expect(urls.get(url)?.type).toBe("image/bmp");
  });

  it("fetches an image known by URL, keyed by the URL, and keeps a small one's URL", async () => {
    const big = { mimeType: "image/png", data: "", url: "/api/image/big" };
    const url = await mod.thumbnail(big, RESULT, 2);
    expect(decodes[0]!.options).toMatchObject({ resizeWidth: 896, resizeHeight: 560 });
    expect(mod.readyThumbnail(big, RESULT, 2)).toBe(url);
    expect(await mod.thumbnail({ mimeType: "image/png", data: "", url: "/api/image/small" }, RESULT, 2)).toBe("/api/image/small");
  });

  it("falls back to the original when the image cannot be decoded, without keeping its data URL", async () => {
    fails = true;
    const image = block(png(2000, 1250));
    const original = `data:image/png;base64,${image.data}`;
    expect(await mod.thumbnail(image, RESULT, 2)).toBe(original);
    expect(mod.readyThumbnail(image, RESULT, 2)).toBe(original);
    expect(urls.size).toBe(0);
  });

  it("falls back to the original without crypto.subtle (an insecure page)", async () => {
    vi.stubGlobal("crypto", {});
    const image = block(png(2000, 1250));
    expect(await mod.thumbnail(image, RESULT, 2)).toBe(`data:image/png;base64,${image.data}`);
    expect(decodes).toHaveLength(0);
  });

  it("revokes the oldest thumbnail past the cache limit", async () => {
    const first = await mod.thumbnail(block(png(2000, 1250, 0)), RESULT, 2);
    for (let i = 1; i < 300; i++) await mod.thumbnail(block(png(2000, 1250, i)), RESULT, 2);
    expect(revoked).toEqual([]);
    await mod.thumbnail(block(png(2000, 1250, 300)), RESULT, 2);
    expect(revoked).toEqual([first]);
  });

  /** Starts thumbnails of five images (4000 px wide, 1000 to 1400 tall) at `distances` from the middle of the screen. */
  async function queued(distances: number[]) {
    hold = true;
    // Known by URL, so the requests reach the queue together (a digest's time varies).
    const jobs = distances.map((distance, i) => mod.thumbnail({ mimeType: "image/png", data: "", url: `/api/image/q${i}` }, RESULT, 1, () => distance));
    const started = () => decodes.map((decode) => [115, 127, 138, 150, 161].indexOf(decode.options?.resizeHeight ?? 0));
    await vi.waitFor(() => expect(decodes).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(decodes).toHaveLength(2); // two at a time
    const first = new Set(started());
    for (let next = 2; next < 5; next++) {
      decodes[next - 2]!.resolve();
      await vi.waitFor(() => expect(decodes).toHaveLength(next + 1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(decodes).toHaveLength(next + 1);
    }
    for (const decode of decodes.slice(3)) decode.resolve();
    expect(new Set(await Promise.all(jobs)).size).toBe(5);
    return { first, then: started().slice(2) };
  }

  it("decodes two at a time, those closest to the middle of the screen first", async () => {
    expect(await queued([50, 10, 30, 0, 20])).toEqual({ first: new Set([3, 1]), then: [4, 2, 0] });
  });

  it("decodes the newest request first among equally close ones", async () => {
    expect(await queued([0, 0, 0, 0, 0])).toEqual({ first: new Set([4, 3]), then: [2, 1, 0] });
  });
});
