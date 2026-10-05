import { describe, expect, it } from "vitest";
import { RemoteImages } from "./remote-images";

const big = (fill: string) => Buffer.alloc(20_000, fill).toString("base64");

describe("RemoteImages", () => {
  it("swaps large image blocks for a URL and serves their bytes", () => {
    const images = new RemoteImages();
    const data = big("a");
    const text = JSON.stringify({ items: [{ content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data }] }] }, images.replacer);
    const block = JSON.parse(text).items[0].content[1];
    expect(block).toMatchObject({ type: "image", mimeType: "image/png", data: "" });
    expect(block.url).toMatch(/^\/api\/image\/[a-f0-9]{64}$/);
    const served = images.get(block.url.split("/").at(-1));
    expect(served?.mimeType).toBe("image/png");
    expect(served?.bytes.equals(Buffer.from(data, "base64"))).toBe(true);
  });

  it("leaves small images, unsafe types and other shapes inline", () => {
    const images = new RemoteImages();
    const small = { type: "image", mimeType: "image/png", data: "iVBOR" };
    const svg = { type: "image", mimeType: "image/svg+xml", data: big("b") };
    const card = { mimeType: "image/png", data: big("c") };
    expect(JSON.parse(JSON.stringify([small, svg, card], images.replacer))).toEqual([small, svg, card]);
  });

  it("evicts the least recently used images past the cap", () => {
    const one = big("1");
    const images = new RemoteImages(one.length * 2);
    const url = (data: string) => JSON.parse(JSON.stringify({ type: "image", mimeType: "image/jpeg", data }, images.replacer)).url.split("/").at(-1);
    const [a, b] = [url(one), url(big("2"))];
    images.get(a); // a is now the newest
    const c = url(big("3"));
    expect(images.get(b)).toBeUndefined();
    expect(images.get(a)).toBeDefined();
    expect(images.get(c)).toBeDefined();
  });
});
