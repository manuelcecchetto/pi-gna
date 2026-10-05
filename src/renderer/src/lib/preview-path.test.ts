import { describe, expect, it } from "vitest";
import { resolveFilePath } from "./preview-path";

describe("resolveFilePath", () => {
  it("keeps absolute paths and normalizes them", () => {
    expect(resolveFilePath("/a/b/../c.ts", "/cwd", "/home/me")).toBe("/a/c.ts");
  });
  it("resolves relative paths against the cwd", () => {
    expect(resolveFilePath("src/x.ts", "/proj", "/home/me")).toBe("/proj/src/x.ts");
    expect(resolveFilePath("./../y.md", "/proj/app", undefined)).toBe("/proj/y.md");
  });
  it("expands ~ against home", () => {
    expect(resolveFilePath("~/notes/a.md", "/proj", "/home/me")).toBe("/home/me/notes/a.md");
    expect(resolveFilePath("~", "/proj", "/home/me")).toBe("/home/me");
  });
  it("gives up when the base is unknown", () => {
    expect(resolveFilePath("x.ts", undefined, "/h")).toBeUndefined();
    expect(resolveFilePath("~/x", "/p", undefined)).toBeUndefined();
    expect(resolveFilePath("  ", "/p", "/h")).toBeUndefined();
  });
});
