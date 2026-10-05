import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreviewTargets } from "./resolve-targets";

describe("resolvePreviewTargets", () => {
  it("resolves existing files against the cwd and nulls the rest", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pigna-links-"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a b.ts"), "x");
    const out = await resolvePreviewTargets(cwd, ["src/a%20b.ts:3", "./src/a b.ts#L2", join(cwd, "src/a b.ts"), "src", "nope.ts", "https://x.com/a.ts", "../outside-missing.ts"]);
    expect(out).toEqual([join(cwd, "src/a b.ts"), join(cwd, "src/a b.ts"), join(cwd, "src/a b.ts"), null, null, null, null]);
  });
});
