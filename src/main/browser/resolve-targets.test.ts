import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPreviewImage, resolvePreviewTargets } from "./resolve-targets";

describe("resolvePreviewTargets", () => {
  it("resolves existing files against the cwd and nulls the rest", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pigna-links-"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a b.ts"), "x");
    const out = await resolvePreviewTargets(cwd, ["src/a%20b.ts:3", "./src/a b.ts#L2", join(cwd, "src/a b.ts"), "src", "nope.ts", "https://x.com/a.ts", "../outside-missing.ts"]);
    expect(out).toEqual([join(cwd, "src/a b.ts"), join(cwd, "src/a b.ts"), join(cwd, "src/a b.ts"), null, null, null, null]);
  });
});

describe("readPreviewImage", () => {
  it("reads embedded images by link target and refuses other files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pigna-images-"));
    mkdirSync(join(cwd, "shots"));
    writeFileSync(join(cwd, "shots", "a b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(cwd, "logo.svg"), "<svg/>");
    writeFileSync(join(cwd, "notes.md"), "# x");
    expect(await readPreviewImage(cwd, "shots/a%20b.png")).toEqual({ mimeType: "image/png", data: "iVBORw==" });
    expect(await readPreviewImage(cwd, `file://${cwd}/logo.svg`)).toEqual({ mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") });
    expect(await readPreviewImage(cwd, "notes.md")).toBeNull();
    expect(await readPreviewImage(cwd, "missing.png")).toBeNull();
    expect(await readPreviewImage(cwd, "https://x.com/a.png")).toBeNull();
  });
});
