import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pythonForHost } from "./python";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "pigna-python-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("keeps the POSIX python3 invocation", () => {
  expect(pythonForHost("darwin", "")).toEqual({ file: "python3", args: [], command: "python3" });
});
it("prefers the Windows Python 3 launcher, then a real interpreter", () => {
  const dir = temp();
  writeFileSync(join(dir, "python.exe"), "fixture");
  expect(pythonForHost("win32", dir)).toEqual({ file: join(dir, "python.exe"), args: [], command: "python" });
  writeFileSync(join(dir, "py.exe"), "fixture");
  expect(pythonForHost("win32", dir)).toEqual({ file: join(dir, "py.exe"), args: ["-3"], command: "py -3" });
});
it("does not invoke the Store alias and explains a missing interpreter", () => {
  const dir = join(temp(), "Microsoft", "WindowsApps");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "python.exe"), "fixture");
  writeFileSync(join(dir, "python3.exe"), "fixture");
  expect(() => pythonForHost("win32", dir)).toThrow(/Python 3 is not installed/);
});
