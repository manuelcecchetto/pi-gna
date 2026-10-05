import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browse } from "./browse";

let base: string;
let home: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pigna-browse-")));
  home = join(base, "home");
  await mkdir(join(home, "code", "app"), { recursive: true });
  await mkdir(join(home, ".config"), { recursive: true });
  await mkdir(join(base, "outside"));
  await writeFile(join(home, "note.txt"), "x");
  await symlink(join(base, "outside"), join(home, "escape"));
  await symlink(join(home, "code"), join(home, "shortcut"));
});
afterAll(() => rm(base, { recursive: true, force: true }));

const names = (listing: { folders: { name: string }[] }) => listing.folders.map((f) => f.name);

describe("fs.browseFolders", () => {
  it("starts at home, lists folders only, hides dot-folders and links that leave home", async () => {
    const listing = await browse(home, undefined, false);
    expect(listing.path).toBe(home);
    expect(listing.parent).toBeNull();
    expect(names(listing)).toEqual(["code", "shortcut"]);
    expect(listing.files).toBeUndefined();
  });

  it("shows hidden folders only when asked, and files only when asked", async () => {
    expect(names(await browse(home, home, false, true))).toEqual([".config", "code", "shortcut"]);
    expect((await browse(home, home, true)).files?.map((f) => f.name)).toEqual(["note.txt"]);
  });

  it("walks down and reports the parent", async () => {
    const listing = await browse(home, join(home, "code"), false);
    expect(names(listing)).toEqual(["app"]);
    expect(listing.parent).toBe(home);
  });

  it("refuses relative, NUL, missing, outside and non-folder paths", async () => {
    await expect(browse(home, "code", false)).rejects.toMatchObject({ code: "bad_request" });
    await expect(browse(home, 5, false)).rejects.toMatchObject({ code: "bad_request" });
    await expect(browse(home, join(home, "a\0b"), false)).rejects.toMatchObject({ code: "bad_request" });
    await expect(browse(home, join(home, "missing"), false)).rejects.toMatchObject({ code: "not_found" });
    await expect(browse(home, base, false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(browse(home, join(home, "escape"), false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(browse(home, join(home, "code", "..", ".."), false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(browse(home, join(home, "note.txt"), false)).rejects.toMatchObject({ code: "bad_request" });
  });
});
