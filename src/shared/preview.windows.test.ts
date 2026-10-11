import { describe, expect, it } from "vitest";
import { isLocalLinkHref, looksLikePath, parseLinkTarget, parseLocalTarget, resolveFilePath } from "./preview";

// Run on every OS: a phone must parse the host's paths, not its own platform's paths.
const cwd = String.raw`C:\Users\me\My Project`;
const home = String.raw`C:\Users\me`;

describe("Windows preview paths", () => {
  it.each([
    [String.raw`C:\Users\me\a b\ü.md`, String.raw`C:\Users\me\a b\ü.md`],
    ["C:/Users/me/a b/ü.md", String.raw`C:\Users\me\a b\ü.md`],
    [String.raw`D:\work\..\a.md`, String.raw`D:\a.md`],
    ["D:/../../a.md", String.raw`D:\a.md`],
    ["D:/", "D:\\"],
    [String.raw`\\server\share\a.md`, String.raw`\\server\share\a.md`],
    [String.raw`\\server\share\..\..\a.md`, String.raw`\\server\share\a.md`],
    ["file:///C:/Users/me/a%20b.md", String.raw`C:\Users\me\a b.md`],
    ["file://localhost/C:/Users/me/a.md", String.raw`C:\Users\me\a.md`],
    [String.raw`.\src\a.ts`, String.raw`C:\Users\me\My Project\src\a.ts`],
    ["./src/a.ts", String.raw`C:\Users\me\My Project\src\a.ts`],
    [String.raw`..\a.ts`, String.raw`C:\Users\me\a.ts`],
    [String.raw`~\docs\a.md`, String.raw`C:\Users\me\docs\a.md`],
    ["~/docs/a.md", String.raw`C:\Users\me\docs\a.md`],
  ])("resolves %s without a local OS dependency", (input, path) => {
    expect(parseLocalTarget(input, cwd, home)).toEqual({ path });
    expect(parseLinkTarget(input, cwd, home)).toEqual({ path });
    expect(isLocalLinkHref(input)).toBe(true);
  });

  it("keeps drive letters separate from line and column suffixes", () => {
    expect(parseLocalTarget(String.raw`C:\work\a.ts:12:3`)).toEqual({ path: String.raw`C:\work\a.ts`, line: 12, column: 3 });
    expect(parseLocalTarget("C:/work/a.ts#L10-L20")).toEqual({ path: String.raw`C:\work\a.ts`, line: 10 });
    expect(parseLocalTarget("file:///C:/work/a%20b.ts#L7C2")).toEqual({ path: String.raw`C:\work\a b.ts`, line: 7, column: 2 });
    expect(parseLocalTarget(String.raw`\\server\share\a.ts:4`)).toEqual({ path: String.raw`\\server\share\a.ts`, line: 4 });
  });

  it("resolves bare Markdown paths using either separator", () => {
    expect(parseLinkTarget(String.raw`src\a.ts:12`, cwd)).toEqual({ path: String.raw`C:\Users\me\My Project\src\a.ts`, line: 12 });
    expect(parseLinkTarget("docs/A%20b.md#L10", cwd)).toEqual({ path: String.raw`C:\Users\me\My Project\docs\A b.md`, line: 10 });
    expect(parseLinkTarget("C%3A%2Fwork%2Fa.md")).toEqual({ path: String.raw`C:\work\a.md` });
    expect(parseLocalTarget("src/a.ts", cwd)).toBeUndefined();
  });

  it.each([String.raw`C:\work\a.ts`, "C:/work/a.ts:12", String.raw`src\a.ts`, String.raw`\\server\share\a.md`])("recognizes inline-code path %s", (input) => {
    expect(looksLikePath(input)).toBe(true);
  });

  it.each([String.raw`\\?\C:\a.md`, String.raw`\\.\pipe\secret`, String.raw`\\server`, String.raw`\root-relative.md`, "C:relative.md", "C:/a\0.md"])(
    "refuses ambiguous or device path %s", (input) => {
      expect(parseLocalTarget(input, cwd, home)).toBeUndefined();
      expect(parseLinkTarget(input, cwd, home)).toBeUndefined();
      expect(resolveFilePath(input, cwd, home)).toBeUndefined();
    },
  );

  it("does not turn encoded URI schemes into relative local files", () => {
    expect(parseLinkTarget("https%3A%2F%2Fexample.com/a.md", cwd)).toBeUndefined();
    expect(parseLinkTarget("%5C%5C.%5Cpipe%5Csecret", cwd)).toBeUndefined();
  });

  it("resolves literal tool paths without decoding names or stripping suffixes", () => {
    expect(resolveFilePath("src/100%20done.ts", cwd)).toBe(String.raw`C:\Users\me\My Project\src\100%20done.ts`);
    expect(resolveFilePath("~/a.md", cwd, home)).toBe(String.raw`C:\Users\me\a.md`);
    expect(resolveFilePath("~/a.md", cwd)).toBeUndefined();
    expect(resolveFilePath(String.raw`D:\a.md`, cwd)).toBe(String.raw`D:\a.md`);
    expect(resolveFilePath("src/a.ts")).toBeUndefined();
  });

  it("does not reinterpret a backslash in a POSIX filename", () => {
    expect(resolveFilePath(String.raw`dir/a\b.ts`, "/work")).toBe(String.raw`/work/dir/a\b.ts`);
  });
});
