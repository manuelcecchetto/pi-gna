import { describe, expect, it } from "vitest";
import { normalizeAddress } from "./browser";
import { isLocalLinkHref, kindFor, looksLikePath, parseLinkTarget, languageFor, modesFor, parseLocalTarget, parsePreviewUrl, previewFor, previewLabel, previewUrl, servedAs } from "./preview";

describe("kindFor", () => {
  it.each([
    ["a.pdf", "pdf"], ["a.png", "image"], ["a.jpeg", "image"], ["a.gif", "image"], ["a.webp", "image"], ["a.avif", "image"],
    ["a.bmp", "image"], ["a.ico", "image"], ["a.svg", "image"], ["a.docx", "docx"], ["a.md", "markdown"], ["a.mdx", "markdown"],
    ["a.html", "html"], ["a.htm", "html"], ["a.json", "json"], ["a.csv", "table"], ["a.tsv", "table"], ["a.mp4", "video"],
    ["a.webm", "video"], ["a.mp3", "audio"], ["a.flac", "audio"], ["a.ts", "code"], ["a.py", "code"], ["a.txt", "text"],
    ["a.doc", "other"], ["a.xlsx", "other"], ["a.bin", "other"],
  ])("%s -> %s", (path, kind) => expect(kindFor(path)).toBe(kind));

  it("is case-insensitive", () => {
    expect(kindFor("/x/REPORT.PDF")).toBe("pdf");
    expect(kindFor("/x/Photo.JpG")).toBe("image");
  });

  it("handles files without extension and dotfiles", () => {
    expect(kindFor("/x/README")).toBe("other");
    expect(kindFor("/x/Dockerfile")).toBe("code");
    expect(kindFor("/x/.env")).toBe("text");
    expect(kindFor("/x/.gitignore")).toBe("text");
    expect(kindFor("/x/.bashrc")).toBe("other");
    expect(kindFor("/x.dir/file")).toBe("other");
    expect(kindFor("/x/archive.tar.gz")).toBe("other");
  });

  it("maps code to shiki languages", () => {
    expect(languageFor("a.ts")).toBe("typescript");
    expect(languageFor("A.TSX")).toBe("tsx");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("a.txt")).toBeUndefined();
  });
});

describe("modes", () => {
  it("lists supported modes, default first", () => {
    expect(modesFor("a.md")).toEqual(["rendered", "raw"]);
    expect(modesFor("a.svg")).toEqual(["rendered", "raw"]);
    expect(modesFor("a.png")).toEqual(["rendered"]);
    expect(modesFor("a.ts")).toEqual(["raw"]);
    expect(modesFor("a.pdf")).toEqual(["rendered"]);
  });

  it("serves pdf and rendered html raw, the rest through the viewer", () => {
    expect(servedAs("pdf", "rendered")).toBe("raw");
    expect(servedAs("html", "rendered")).toBe("raw");
    expect(servedAs("html", "raw")).toBe("viewer");
    expect(servedAs("markdown", "rendered")).toBe("viewer");
    expect(servedAs("video", "rendered")).toBe("viewer");
  });

  it("builds tab preview state", () => {
    expect(previewFor("/p/a.md")).toEqual({ path: "/p/a.md", name: "a.md", kind: "markdown", mode: "rendered", modes: ["rendered", "raw"] });
    expect(previewFor("/p/a.ts").mode).toBe("raw");
  });
});

describe("previewLabel", () => {
  it("adds the parent directory only for duplicates", () => {
    expect(previewLabel("/a/x/index.md")).toBe("index.md");
    expect(previewLabel("/a/x/index.md", ["/a/x/index.md", "/a/y/index.md"])).toBe("x/index.md");
    expect(previewLabel("/a/x/index.md", ["/a/x/index.md", "/a/y/other.md"])).toBe("index.md");
  });
});

describe("parseLocalTarget", () => {
  it("recognizes absolute, home and file URL input", () => {
    expect(parseLocalTarget("/Users/me/a b/ü.md")).toEqual({ path: "/Users/me/a b/ü.md" });
    expect(parseLocalTarget("  /tmp/x.pdf  ")).toEqual({ path: "/tmp/x.pdf" });
    expect(parseLocalTarget("~/docs/a.md", undefined, "/Users/me")).toEqual({ path: "/Users/me/docs/a.md" });
    expect(parseLocalTarget("~/docs/a.md")).toEqual({ path: "~/docs/a.md" });
    expect(parseLocalTarget("file:///Users/me/a%20b%23c%3F.md")).toEqual({ path: "/Users/me/a b#c?.md" });
    expect(parseLocalTarget("file://localhost/tmp/a.md")).toEqual({ path: "/tmp/a.md" });
  });

  it("parses line and column suffixes", () => {
    expect(parseLocalTarget("/p/a.ts:12")).toEqual({ path: "/p/a.ts", line: 12 });
    expect(parseLocalTarget("/p/a.ts:12:5")).toEqual({ path: "/p/a.ts", line: 12, column: 5 });
    expect(parseLocalTarget("file:///p/a.ts:7")).toEqual({ path: "/p/a.ts", line: 7 });
  });

  it("resolves relative input only against a cwd", () => {
    expect(parseLocalTarget("./src/a.ts", "/p")).toEqual({ path: "/p/src/a.ts" });
    expect(parseLocalTarget("../a.ts:3", "/p/q")).toEqual({ path: "/p/a.ts", line: 3 });
    expect(parseLocalTarget("./a.ts")).toBeUndefined();
    expect(parseLocalTarget("src/a.ts", "/p")).toBeUndefined();
  });

  it("leaves web addresses and Windows paths alone", () => {
    for (const input of ["https://example.com/a.pdf", "http://localhost:3000", "localhost:3000", "example.com/x", "//host/x", "C:\\a\\b.md", "C:/a/b.md", "file:///C:/a/b.md", "\\\\srv\\share", "file://host/a", "", "hello world", "about:blank"]) {
      expect(parseLocalTarget(input), input).toBeUndefined();
    }
  });

  it("does not change normalizeAddress for web input", () => {
    expect(normalizeAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
  });
});

describe("preview URLs", () => {
  it("round-trips awkward names", () => {
    const rel = "docs/a b/ü #1?.md";
    const url = previewUrl("abc123", rel);
    expect(url).toBe("pigna-file://abc123/docs/a%20b/%C3%BC%20%231%3F.md");
    expect(parsePreviewUrl(url)).toEqual({ token: "abc123", relative: rel, view: undefined, raw: false });
  });

  it("carries the view and raw flags", () => {
    expect(previewUrl("t", "a.md", "raw")).toBe("pigna-file://t/a.md?view=raw");
    expect(parsePreviewUrl("pigna-file://t/a.md?view=raw")?.view).toBe("raw");
    expect(parsePreviewUrl("pigna-file://t/a.png?raw=1")?.raw).toBe(true);
  });

  it("rejects other schemes and bad escapes", () => {
    expect(parsePreviewUrl("https://t/a.md")).toBeUndefined();
    expect(parsePreviewUrl("pigna-file://t/%E0%A4%A")).toBeUndefined();
    expect(parsePreviewUrl("nonsense")).toBeUndefined();
  });
});

describe("#L line anchors", () => {
  it("reads GitHub-style anchors", () => {
    expect(parseLocalTarget("/p/a.ts#L10")).toEqual({ path: "/p/a.ts", line: 10 });
    expect(parseLocalTarget("/p/a.ts#L10-L20")).toEqual({ path: "/p/a.ts", line: 10 });
    expect(parseLocalTarget("/p/a.ts#L10C3")).toEqual({ path: "/p/a.ts", line: 10, column: 3 });
    expect(parseLocalTarget("file:///p/a%20b.ts#L7")).toEqual({ path: "/p/a b.ts", line: 7 });
    expect(parseLocalTarget("./a.md#L3", "/p")).toEqual({ path: "/p/a.md", line: 3 });
  });
});

describe("link targets", () => {
  it("separates local files from web links", () => {
    for (const href of ["/abs/a.ts", "/abs/a.ts:12", "~/a.md", "./a.md", "../a.md#L2", "src/a.ts", "docs/A.md#L10", "file:///a/b.ts", "README.md", "a.ts:12", "a%20b/c.md"]) {
      expect(isLocalLinkHref(href), href).toBe(true);
    }
    for (const href of ["https://x.com/a.ts", "http://localhost:3000", "mailto:a@b.c", "javascript:alert(1)", "data:text/html,x", "#top", "//host/x", "", "C:\\a\\b", "tel:123"]) {
      expect(isLocalLinkHref(href), href).toBe(false);
    }
  });

  it("resolves them against the cwd", () => {
    expect(parseLinkTarget("src/a.ts:120", "/p")).toEqual({ path: "/p/src/a.ts", line: 120 });
    expect(parseLinkTarget("docs/A%20b.md#L10-L12", "/p")).toEqual({ path: "/p/docs/A b.md", line: 10 });
    expect(parseLinkTarget("../x/a.ts", "/p/q")).toEqual({ path: "/p/x/a.ts" });
    expect(parseLinkTarget("/abs/a.ts#L4", "/p")).toEqual({ path: "/abs/a.ts", line: 4 });
    expect(parseLinkTarget("~/a.md", "/p", "/Users/me")).toEqual({ path: "/Users/me/a.md" });
    expect(parseLinkTarget("src/a.ts")).toBeUndefined();
    expect(parseLinkTarget("https://x.com/a.ts", "/p")).toBeUndefined();
  });
});

describe("looksLikePath", () => {
  it("accepts file paths", () => {
    for (const code of ["src/foo.ts", "src/foo.ts:12", "src/foo.ts:12:3", "/abs/x.md", "~/a/b.json", "./a.ts", "../a.ts", "README.md", "docs/A.md#L10", "package.json", "a/.env.local"]) {
      expect(looksLikePath(code), code).toBe(true);
    }
  });

  it("rejects look-alikes", () => {
    for (const code of ["https://x.com/a.ts", "1.2.3", "v1.2", "and/or", "a.b", "e.g.", "foo()", "foo.bar()", "a b.ts", "src/", "x = a/b.ts", "--flag.x", "obj.prop", "$HOME/a.ts", "a/b"]) {
      expect(looksLikePath(code), code).toBe(false);
    }
  });
});
