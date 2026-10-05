import { describe, expect, it } from "vitest";
import { escapeHtml, formatBytes, lineFromHash, looksLikeText, pageFromHash, splitLines } from "./format";

describe("viewer helpers", () => {
  it("reads the PDF page from #page= or the line", () => {
    expect(pageFromHash("#page=3")).toBe(3);
    expect(pageFromHash("#zoom=100&page=7")).toBe(7);
    expect(pageFromHash("", 4)).toBe(4);
    expect(pageFromHash("#page=0")).toBeUndefined();
    expect(pageFromHash("#nopage=2")).toBeUndefined();
  });

  it("formats sizes", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50.0 MB");
  });

  it("sniffs text from binary", () => {
    expect(looksLikeText(new TextEncoder().encode("héllo\n"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });

  it("escapes html and splits lines", () => {
    expect(escapeHtml("<a & b>")).toBe("&lt;a &amp; b&gt;");
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([""]);
  });

  it("reads the line from the hash", () => {
    expect(lineFromHash("#L42")).toBe(42);
    expect(lineFromHash("#7-9")).toBe(7);
    expect(lineFromHash("#top")).toBeUndefined();
    expect(lineFromHash("#L0")).toBeUndefined();
  });
});
