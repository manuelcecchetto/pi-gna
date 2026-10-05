import { describe, expect, it } from "vitest";
import { classifyLink, resolveImage, slugify, splitFrontMatter } from "./links";

const base = "pigna-file://tok/docs/README.md?view=rendered";

describe("splitFrontMatter", () => {
  it("reads flat pairs and returns the body", () => {
    const result = splitFrontMatter('---\ntitle: "Hi"\ntags: a, b\n---\n# Body\n');
    expect(result.entries).toEqual([["title", "Hi"], ["tags", "a, b"]]);
    expect(result.body).toBe("# Body\n");
  });
  it("leaves documents without a block alone", () => {
    expect(splitFrontMatter("# T\n---\nx: 1\n---\n")).toEqual({ entries: [], body: "# T\n---\nx: 1\n---\n" });
  });
});

describe("slugify", () => {
  it("lowercases, drops punctuation and dedupes", () => {
    const seen = new Map<string, number>();
    expect(slugify("Hello, World!", seen)).toBe("hello-world");
    expect(slugify("Hello World", seen)).toBe("hello-world-1");
  });
});

describe("classifyLink", () => {
  it("classifies by destination", () => {
    expect(classifyLink("#intro", base)).toEqual({ type: "anchor", id: "intro" });
    expect(classifyLink("README.md#intro", base)).toEqual({ type: "anchor", id: "intro" });
    expect(classifyLink("../src/a.ts#L3", base)).toEqual({ type: "local", url: "pigna-file://tok/src/a.ts#L3" });
    expect(classifyLink("https://x.dev/a", base)).toEqual({ type: "web", url: "https://x.dev/a" });
    expect(classifyLink("javascript:alert(1)", base)).toEqual({ type: "drop" });
    expect(classifyLink("file:///etc/passwd", base)).toEqual({ type: "drop" });
    expect(classifyLink("pigna-file://other/x", base)).toEqual({ type: "drop" });
  });
});

describe("resolveImage", () => {
  it("adds raw=1 to same-origin images and blocks remote ones", () => {
    expect(resolveImage("img/a.png", base)).toEqual({ type: "local", url: "pigna-file://tok/docs/img/a.png?raw=1" });
    expect(resolveImage("https://x.dev/a.png", base)).toEqual({ type: "remote" });
    expect(resolveImage("data:image/svg+xml,<svg/>", base)).toEqual({ type: "drop" });
    expect(resolveImage("data:image/png;base64,AAAA", base)).toEqual({ type: "data", url: "data:image/png;base64,AAAA" });
  });
});
