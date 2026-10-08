import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadShellEnv } from "./shell-env";

const KEYS = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PIGNA_TEST_SHELL_VAR"];
let saved: Record<string, string | undefined>;
let dir: string;

/** A login shell that answers after `delay` seconds with these variables. */
async function fakeShell(vars: Record<string, string>, delay = 0.3): Promise<string> {
  const body = Object.entries(vars).map(([k, v]) => `${k}=${v}\\0`).join("");
  const file = join(dir, "shell");
  await writeFile(file, `#!/bin/sh\nsleep ${delay}\nprintf '__PIGNA_ENV__${body}__PIGNA_ENV__'\n`);
  await chmod(file, 0o755);
  return file;
}
const settled = (promise: Promise<unknown>, ms = 100) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  dir = await mkdtemp(join(tmpdir(), "pigna-shell-env-"));
});
afterEach(() => {
  for (const key of KEYS) saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key]);
});

describe.skipIf(process.platform === "win32")("loadShellEnv", () => {
  it("on the first launch, knows pi's folders only once the shell answers, then keeps them", async () => {
    const cache = join(dir, "shell-dirs.json");
    const loaded = loadShellEnv(cache, await fakeShell({ PI_CODING_AGENT_DIR: "/shell/agent", PIGNA_TEST_SHELL_VAR: "secret" }));
    expect(await settled(loaded.piDirs)).toBe(false);
    await loaded.env;
    await loaded.piDirs;
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/shell/agent");
    expect(process.env.PIGNA_TEST_SHELL_VAR).toBe("secret");
    // Only the folders reach the disk.
    expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ PI_CODING_AGENT_DIR: "/shell/agent" });
  });

  it("applies the kept folders at once, and lets the shell's answer replace them", async () => {
    const cache = join(dir, "shell-dirs.json");
    await writeFile(cache, JSON.stringify({ PI_CODING_AGENT_DIR: "/old/agent", PI_CODING_AGENT_SESSION_DIR: "/old/sessions" }));
    const loaded = loadShellEnv(cache, await fakeShell({ PI_CODING_AGENT_DIR: "/new/agent" }));
    expect(await settled(loaded.piDirs)).toBe(true);
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/old/agent");
    expect(await settled(loaded.env)).toBe(false);
    await loaded.env;
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/new/agent");
    expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ PI_CODING_AGENT_DIR: "/new/agent" });
  });

  it("does not hand the kept folders to the shell it asks", async () => {
    const cache = join(dir, "shell-dirs.json");
    await writeFile(cache, JSON.stringify({ PI_CODING_AGENT_DIR: "/old/agent" }));
    const shell = join(dir, "echo-shell");
    // Reports PI_CODING_AGENT_DIR only if it inherited one.
    await writeFile(shell, `#!/bin/sh\nsleep 0.2\nprintf '__PIGNA_ENV__'\n[ -n "$PI_CODING_AGENT_DIR" ] && printf "PI_CODING_AGENT_DIR=%s\\\\0" "$PI_CODING_AGENT_DIR"\nprintf '__PIGNA_ENV__'\n`);
    await chmod(shell, 0o755);
    const loaded = loadShellEnv(cache, shell);
    await loaded.env;
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({});
  });

  it("keeps the folders it had when the shell fails", async () => {
    const cache = join(dir, "shell-dirs.json");
    await writeFile(cache, JSON.stringify({ PI_CODING_AGENT_DIR: "/old/agent" }));
    const loaded = loadShellEnv(cache, join(dir, "missing-shell"));
    await loaded.env;
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/old/agent");
    expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ PI_CODING_AGENT_DIR: "/old/agent" });
  });
});
