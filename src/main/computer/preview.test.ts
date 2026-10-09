import { describe, expect, it, vi } from "vitest";
import { alike, ComputerPreviews, PREVIEW_WIDTH, type Small, shrinkWith } from "./preview";

const shot = (data: string, app = "Notes") => ({ mimeType: "image/png", data, app });
/** One pixel by the capture's name ("one" 122, "two" 146); a trailing ~ is the same window with capture noise. */
const pixelsOf = (jpeg: string) => {
  const v = [...jpeg.replace(/~$/, "")].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 200;
  return Buffer.from([jpeg.endsWith("~") ? v + 10 : v, v, v, 255]);
};

function setup(shrink: (jpeg: string) => Small | undefined = (jpeg) => ({ data: `small-${jpeg}`, pixels: pixelsOf(jpeg) })) {
  let next: ReturnType<typeof shot> | null = shot("one");
  const capture = vi.fn(async (_handle: string) => next);
  const shrinkSpy = vi.fn(shrink);
  return { previews: new ComputerPreviews(capture, shrinkSpy), capture, shrink: shrinkSpy, set: (value: ReturnType<typeof shot> | null) => (next = value) };
}

describe("ComputerPreviews", () => {
  it("sends the shrunk frame, then only its id while the phone has it", async () => {
    const t = setup();
    const first = await t.previews.frame("a");
    expect(first).toMatchObject({ app: "Notes", mimeType: "image/jpeg", data: "small-one" });
    expect(first?.id).toMatch(/^[\w-]{16}$/);
    expect(await t.previews.frame("a", first?.id)).toEqual({ id: first?.id, app: "Notes" });
    expect(await t.previews.frame("a", "other")).toEqual(first);
    expect(await t.previews.frame("a")).toEqual(first);
    expect(t.shrink).toHaveBeenCalledTimes(1);
    expect(t.capture).toHaveBeenCalledWith("a");
  });

  it("keeps the id of a capture that differs from the last by noise only", async () => {
    const t = setup();
    t.set(shot("one"));
    const first = await t.previews.frame("a");
    t.set(shot("one~"));
    expect(await t.previews.frame("a", first?.id)).toEqual({ id: first?.id, app: "Notes" });
    expect(await t.previews.frame("a")).toEqual(first);
    expect(t.shrink).toHaveBeenCalledTimes(2);
    // The same noisy bytes again are not shrunk again.
    await t.previews.frame("a", first?.id);
    expect(t.shrink).toHaveBeenCalledTimes(2);
  });

  it("shrinks a changed frame again and gives it another id", async () => {
    const t = setup();
    const first = await t.previews.frame("a");
    t.set(shot("two", "Mail"));
    const second = await t.previews.frame("a", first?.id);
    expect(second).toMatchObject({ app: "Mail", data: "small-two" });
    expect(second?.id).not.toBe(first?.id);
    expect(t.shrink).toHaveBeenCalledTimes(2);
  });

  it("answers null when the chat holds nothing and forgets its frame", async () => {
    const t = setup();
    const first = await t.previews.frame("a");
    t.set(null);
    expect(await t.previews.frame("a", first?.id)).toBeNull();
    t.set(shot("one"));
    expect(await t.previews.frame("a", first?.id)).toEqual({ id: first?.id, app: "Notes" });
    expect(t.shrink).toHaveBeenCalledTimes(2);
  });

  it("sends the frame as captured when it cannot shrink it", async () => {
    for (const shrink of [() => undefined, () => { throw new Error("decode"); }]) {
      const t = setup(shrink);
      const first = await t.previews.frame("a");
      expect(first).toMatchObject({ mimeType: "image/png", data: "one" });
      t.set(shot("one~"));
      expect(await t.previews.frame("a", first?.id)).toMatchObject({ data: "one~" });
    }
  });

  it("keeps the last frame of eight chats", async () => {
    const t = setup();
    for (let i = 0; i < 9; i++) await t.previews.frame(`h${i}`);
    expect(t.shrink).toHaveBeenCalledTimes(9);
    await t.previews.frame("h8");
    await t.previews.frame("h1");
    expect(t.shrink).toHaveBeenCalledTimes(9);
    await t.previews.frame("h0");
    expect(t.shrink).toHaveBeenCalledTimes(10);
    // The least recently asked (h2) went, not the first kept (h1).
    await t.previews.frame("h1");
    expect(t.shrink).toHaveBeenCalledTimes(10);
    await t.previews.frame("h2");
    expect(t.shrink).toHaveBeenCalledTimes(11);
  });
});

describe("alike", () => {
  it("is true within 16 levels on every channel and false past it or for another size", () => {
    expect(alike(Buffer.from([10, 200, 0, 255]), Buffer.from([26, 184, 16, 255]))).toBe(true);
    expect(alike(Buffer.from([10, 200, 0, 255]), Buffer.from([27, 200, 0, 255]))).toBe(false);
    expect(alike(Buffer.from([10, 200, 0, 255]), Buffer.from([10, 200, 0, 238]))).toBe(false);
    expect(alike(Buffer.from([10, 200, 0, 255]), Buffer.from([10, 200, 0, 255, 0]))).toBe(false);
  });
});

describe("shrinkWith", () => {
  const image = (width: number, empty = false) => {
    const resized = { toJPEG: vi.fn(() => Buffer.from("resized")), toBitmap: () => Buffer.from([1]) };
    const self = { isEmpty: () => empty, getSize: () => ({ width, height: width / 2 }), resize: vi.fn(() => resized), toJPEG: vi.fn(() => Buffer.from("same")), toBitmap: () => Buffer.from([2]) };
    return { self, resized };
  };
  const shrinkOf = (img: unknown) => shrinkWith({ createFromBuffer: vi.fn(() => img) } as never);

  it("resizes a wide frame to PREVIEW_WIDTH at JPEG 75", () => {
    const { self, resized } = image(PREVIEW_WIDTH + 1);
    expect(shrinkOf(self)(Buffer.from("x").toString("base64"))).toEqual({ data: Buffer.from("resized").toString("base64"), pixels: Buffer.from([1]) });
    expect(self.resize).toHaveBeenCalledWith({ width: PREVIEW_WIDTH, quality: "good" });
    expect(resized.toJPEG).toHaveBeenCalledWith(75);
  });

  it("re-encodes a narrow frame as it is, and gives up on one it cannot decode", () => {
    const narrow = image(PREVIEW_WIDTH);
    expect(shrinkOf(narrow.self)("eA==")).toEqual({ data: Buffer.from("same").toString("base64"), pixels: Buffer.from([2]) });
    expect(narrow.self.resize).not.toHaveBeenCalled();
    expect(narrow.self.toJPEG).toHaveBeenCalledWith(75);
    expect(shrinkOf(image(2000, true).self)("eA==")).toBeUndefined();
  });
});
