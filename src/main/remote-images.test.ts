import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RemoteImages } from "./remote-images";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

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

  it("hashes a block once however often it is serialized, and again once edited", () => {
    const images = new RemoteImages();
    const block = { type: "image", mimeType: "image/png", data: big("d") };
    const hashes = vi.mocked(crypto.createHash);
    hashes.mockClear();
    const first = JSON.stringify([block], images.replacer);
    expect(JSON.stringify({ again: block }, images.replacer)).toBe(JSON.stringify({ again: JSON.parse(first)[0] }));
    expect(hashes).toHaveBeenCalledTimes(1);
    block.data = big("e");
    const edited = JSON.parse(JSON.stringify(block, images.replacer)).url.split("/").at(-1);
    expect(hashes).toHaveBeenCalledTimes(2);
    expect(images.get(edited)?.bytes.equals(Buffer.from(block.data, "base64"))).toBe(true);
  });

  it("serves a known block again after its bytes were evicted", () => {
    const one = big("1");
    const images = new RemoteImages(one.length);
    const block = { type: "image", mimeType: "image/png", data: one };
    const url = (b: object) => JSON.parse(JSON.stringify(b, images.replacer)).url.split("/").at(-1);
    const a = url(block);
    url({ type: "image", mimeType: "image/png", data: big("2") });
    expect(images.get(a)).toBeUndefined();
    expect(url(block)).toBe(a);
    expect(images.get(a)).toBeDefined();
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
