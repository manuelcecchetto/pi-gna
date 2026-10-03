import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CardImages } from "./card-images";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const folder = () => mkdtemp(join(tmpdir(), "pigna-card-images-"));

describe("CardImages", () => {
  it("saves a card's images in its own folder and deletes them with the card", async () => {
    const dir = await folder();
    const images = new CardImages(dir);
    const first = await images.save("abc123", { mimeType: "image/png", data: png.toString("base64") });
    const second = await images.save("abc123", { mimeType: "image/jpeg", data: png.toString("base64") });
    expect(dirname(first)).toBe(join(dir, "abc123"));
    expect(first).toMatch(/\/image-[0-9a-f-]{36}\.png$/);
    expect(second).toMatch(/\.jpeg$/);
    expect(await readFile(first)).toEqual(png);
    await images.save("zzz999", { mimeType: "image/png", data: png.toString("base64") });
    await images.remove("abc123");
    expect(await readdir(dir)).toEqual(["zzz999"]);
    await images.remove("abc123"); // already gone
  });

  it("refuses ids that are not card ids, types pi cannot read and empty or huge images", async () => {
    const dir = await folder();
    const images = new CardImages(dir);
    const data = png.toString("base64");
    await expect(images.save("../etc", { mimeType: "image/png", data })).rejects.toThrow("invalid card id");
    await expect(images.save("abc123", { mimeType: "image/svg+xml", data })).rejects.toThrow("not an image");
    await expect(images.save("abc123", { mimeType: "image/png", data: "" })).rejects.toThrow("empty");
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    await expect(images.save("abc123", { mimeType: "image/png", data: huge })).rejects.toThrow("too large");
    await images.remove("..");
    expect(await readdir(dir)).toEqual([]);
  });
});
