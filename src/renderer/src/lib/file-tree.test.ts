import { describe, expect, it } from "vitest";
import { entriesBelow, folderEntries, parentDir } from "./file-tree";

const files = ["README.md", "src/b.ts", "src/a.ts", "src/lib/x.ts", "docs/guide/intro.md", ".gitignore"];

describe("folderEntries", () => {
  it("lists the root's folders first, then its files", () => {
    expect(folderEntries(files, "")).toEqual([
      { path: "docs", folder: true },
      { path: "src", folder: true },
      { path: ".gitignore", folder: false },
      { path: "README.md", folder: false },
    ]);
  });
  it("lists a nested folder", () => {
    expect(folderEntries(files, "src").map((e) => e.path)).toEqual(["src/lib", "src/a.ts", "src/b.ts"]);
    expect(folderEntries(files, "docs")).toEqual([{ path: "docs/guide", folder: true }]);
  });
  it("does not match folders that only share a prefix", () => {
    expect(folderEntries(["srcx/y.ts"], "src")).toEqual([]);
  });
});

describe("entriesBelow", () => {
  it("includes every folder and file under the directory", () => {
    const below = entriesBelow(files, "src");
    expect(below.filter((e) => e.folder).map((e) => e.path)).toEqual(["src/lib"]);
    expect(below.filter((e) => !e.folder).map((e) => e.path)).toEqual(["src/b.ts", "src/a.ts", "src/lib/x.ts"]);
    expect(entriesBelow(files, "").filter((e) => e.folder).map((e) => e.path).sort()).toEqual(["docs", "docs/guide", "src", "src/lib"]);
  });
});

describe("parentDir", () => {
  it("strips the last segment", () => {
    expect(parentDir("a/b/c")).toBe("a/b");
    expect(parentDir("a")).toBe("");
  });
});
