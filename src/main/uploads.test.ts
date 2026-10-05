import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_MAX_BYTES } from "../shared/uploads";
import { browse } from "./browse";
import { Uploads } from "./uploads";

let dir: string;
let uploads: Uploads;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pigna-uploads-"));
  uploads = new Uploads(join(dir, "remote-uploads"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const body = (text: string | Buffer) => Readable.from([Buffer.from(text)]);

describe("Uploads", () => {
  it("stores a file under <device>/<uuid>/<sanitized name> and resolves it for that device only", async () => {
    const put = await uploads.put("dev1", "../../evil/notes.txt", "text/plain", body("hello"));
    expect(put.name).toBe("_.._evil_notes.txt");
    expect(put.path).toBe(join(dir, "remote-uploads", "dev1", put.id, put.name));
    expect(readFileSync(put.path, "utf8")).toBe("hello");
    expect(put.image).toBeUndefined();
    expect(await uploads.resolve("dev1", put.id)).toEqual({ path: put.path, name: put.name, isDir: false });
    await expect(uploads.resolve("dev2", put.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(uploads.resolve("dev1", "../dev1")).rejects.toMatchObject({ code: "bad_request" });
    expect(readdirSync(dir)).toEqual(["remote-uploads"]);
  });

  it("returns images with their bytes and gives them the extension their type says", async () => {
    const put = await uploads.put("dev1", "image", "image/jpeg; charset=x", body("JPEGDATA"));
    expect(put.name).toBe("image.jpeg");
    expect(put.image).toEqual({ mimeType: "image/jpeg" });
    expect(await uploads.resolve("dev1", put.id)).toMatchObject({ image: { mimeType: "image/jpeg", data: Buffer.from("JPEGDATA").toString("base64") } });
  });

  it("refuses over the cap, declared or streamed, and leaves nothing on disk", async () => {
    await expect(uploads.put("dev1", "a.bin", "x/y", body("x"), UPLOAD_MAX_BYTES + 1)).rejects.toMatchObject({ code: "payload_too_large" });
    const big = Readable.from((function* () {
      for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024);
    })());
    await expect(uploads.put("dev1", "a.bin", "x/y", big)).rejects.toMatchObject({ code: "payload_too_large" });
    await expect(uploads.put("dev1", "a.bin", "x/y", body(""))).rejects.toMatchObject({ code: "bad_request" });
    expect(readdirSync(join(dir, "remote-uploads", "dev1"))).toEqual([]);
  });

  it("refuses a device id that is not a plain name", async () => {
    await expect(uploads.put("../x", "a", "x/y", body("x"))).rejects.toMatchObject({ code: "bad_request" });
  });

  it("discards, and prunes uploads older than the retention", async () => {
    const old = await uploads.put("dev1", "old.txt", "text/plain", body("o"));
    const fresh = await uploads.put("dev1", "new.txt", "text/plain", body("n"));
    const gone = await uploads.put("dev2", "x.txt", "text/plain", body("x"));
    const stale = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
    utimesSync(join(dir, "remote-uploads", "dev1", old.id), stale, stale);
    utimesSync(join(dir, "remote-uploads", "dev2", gone.id), stale, stale);
    expect(await uploads.prune()).toBe(2);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
    expect(existsSync(join(dir, "remote-uploads", "dev2"))).toBe(false);
    await uploads.discard("dev1", fresh.id);
    expect(existsSync(fresh.path)).toBe(false);
  });
});

describe("browse", () => {
  it("lists folders, and file names on request, below home; refuses outside and does not follow links out", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "proj"), { recursive: true });
    mkdirSync(join(dir, "outside"));
    rmSync(join(dir, "link"), { force: true });
    symlinkSync(join(dir, "outside"), join(home, "escape"));
    writeFileSync(join(home, "a.txt"), "x");
    writeFileSync(join(home, ".hidden"), "x");
    const folders = await browse(home, undefined, false);
    expect(folders.parent).toBeNull();
    expect(folders.folders.map((f) => f.name)).toEqual(["proj"]);
    expect(folders.files).toBeUndefined();
    const withFiles = await browse(home, join(home, "proj"), true);
    expect(withFiles.parent).toBe((await browse(home, undefined, false)).path);
    expect((await browse(home, undefined, true)).files?.map((f) => f.name)).toEqual(["a.txt"]);
    await expect(browse(home, dir, false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(browse(home, join(home, "escape"), false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(browse(home, "relative", false)).rejects.toMatchObject({ code: "bad_request" });
  });
});
