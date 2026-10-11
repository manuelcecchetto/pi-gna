import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPrivateFile } from "../test/fs";
import { writePrivateFile, writePrivateFileSync } from "./private-file";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pigna private & 中文-")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

for (const [name, write] of [["async", writePrivateFile], ["sync", writePrivateFileSync]] as const) {
  describe(`private file (${name})`, () => {
    it("creates a private file, preserving literal UTF-8 bytes", async () => {
      const file = join(dir, "private ' & 中文.json");
      const data = JSON.stringify({ text: "é 中文\n\u0000", fixture: "not a real credential" });
      await write(file, data);
      expect(await readFile(file, "utf8")).toBe(data);
      await assertPrivateFile(file);
    });

    it("never truncates an existing file", async () => {
      const file = join(dir, "existing.json");
      await writeFile(file, "original");
      await expect(Promise.resolve().then(() => write(file, "replacement"))).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe("original");
    });

    it.runIf(process.platform === "win32")("does not inherit a public parent grant", async () => {
      execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [dir, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true });
      const file = join(dir, "private.json");
      await write(file, "fixture");
      await assertPrivateFile(file);
    });

    it.runIf(process.platform === "win32")("refuses the save when the ACL helper is unavailable, without a plaintext fallback", async () => {
      vi.stubEnv("SystemRoot", join(dir, "missing Windows"));
      await expect(Promise.resolve().then(() => write(join(dir, "private.json"), "fixture"))).rejects.toThrow("save was refused");
      expect(await readdir(dir)).toEqual([]);
    });
  });
}

it.skipIf(process.platform === "win32")("can preserve an existing POSIX mode for user-managed settings", async () => {
  const file = join(dir, "settings.json");
  await writePrivateFile(file, "{}", 0o640);
  expect((await stat(file)).mode & 0o777).toBe(0o640);
});
