import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DOCX_REACT, packFont, rewrite } from "./vite.preview.config";

describe("rewrite", () => {
  it("replaces each match literally and fails when one does not occur exactly once", () => {
    expect(rewrite("a=1;b=2", [{ why: "a", from: "a=1", to: "a=$&" }, { why: "b", from: "b=2", to: "b=3" }], "x")).toBe("a=$&;b=3");
    expect(() => rewrite("a=1", [{ why: "b", from: "b=2", to: "" }], "x")).toThrow('x changed: expected one "b=2" to rewrite b');
    expect(() => rewrite("a=1;a=1", [{ why: "a", from: "a=1", to: "" }], "x")).toThrow("x changed");
  });
});

describe("DOCX_REACT", () => {
  // The installed docx-react, as the build reads it.
  const source = readFileSync(fileURLToPath(import.meta.resolve("@betteroffice/docx-react")), "utf8");
  const code = rewrite(source, DOCX_REACT, "docx-react");

  it("raises the open timeout, empties the page mirror and repaints on a density change", () => {
    expect(code).toContain("fullOpenTimeoutMs??12e4");
    expect(code).not.toMatch(/buildMirrorPage(Text)?\(/);
    // The one paint effect that reads the density now also depends on it.
    expect(code.split("window.devicePixelRatio").length).toBe(2);
    expect(code).toContain(",__pignaDensity()])");
  });
});

describe("packFont", () => {
  it("compresses losslessly and reuses the cached copy", async () => {
    const cache = mkdtempSync(join(tmpdir(), "fonts-"));
    const font = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * i) % 251));
    const packed = await packFont(font, cache);
    expect(packed.length).toBeLessThan(font.length);
    expect(brotliDecompressSync(packed).equals(font)).toBe(true);
    const file = readdirSync(cache)[0] ?? "";
    expect(file).toMatch(/^[0-9a-f]{64}\.br$/);
    writeFileSync(join(cache, file), "cached");
    expect((await packFont(font, cache)).toString()).toBe("cached");
  });
});
