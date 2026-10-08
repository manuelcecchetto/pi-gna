import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piInputs, projectTrust, readPiSettings, writePiSettings } from "./pi-settings";

let root: string;

beforeEach(async () => {
  // Spelled as tmpdir() gives it, a symlink on macOS: pi keys trust.json by real path.
  root = await mkdtemp(join(tmpdir(), "pigna-trust-"));
  await mkdir(join(root, "agent"));
  await mkdir(join(root, "repo", "web", "src"), { recursive: true });
  await mkdir(join(root, "repo", "vendor"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("projectTrust", () => {
  it("is the decision saved for the nearest folder", async () => {
    const real = await realpath(root);
    await writeFile(join(root, "agent", "trust.json"), JSON.stringify({ [join(real, "repo")]: true, [join(real, "repo", "vendor")]: false, [join(real, "repo", "web")]: null }));
    expect(await projectTrust(join(root, "repo", "web", "src"))).toBe(true);
    expect(await projectTrust(join(root, "repo", "vendor"))).toBe(false);
    expect(await projectTrust(root)).toBeUndefined();
  });

  it("is undefined without a trust store", async () => {
    expect(await projectTrust(join(root, "repo"))).toBeUndefined();
    await writeFile(join(root, "agent", "trust.json"), "{ not json");
    expect(await projectTrust(join(root, "repo"))).toBeUndefined();
  });
});

describe("piInputs", () => {
  it("changes with what a starting pi reads: its settings, context files from the cwd up, resource folders", async () => {
    const cwd = join(root, "repo", "web");
    let previous = await piInputs(cwd);
    expect(await piInputs(cwd)).toBe(previous);
    const changes = [
      () => writeFile(join(root, "agent", "settings.json"), "{}"),
      () => writeFile(join(root, "agent", "settings.json"), '{ "defaultModel": "opus" }'),
      () => writeFile(join(root, "agent", "trust.json"), "{}"),
      () => writeFile(join(root, "agent", "AGENTS.md"), "# global"),
      () => writeFile(join(root, "repo", "AGENTS.md"), "# project"),
      () => writeFile(join(cwd, "CLAUDE.md"), "# here"),
      () => mkdir(join(cwd, ".pi", "extensions"), { recursive: true }),
      () => writeFile(join(cwd, ".pi", "extensions", "tool.ts"), ""),
    ];
    for (const change of changes) {
      await change();
      const next = await piInputs(cwd);
      expect(next).not.toBe(previous);
      previous = next;
    }
    // Two saves within the clock's step (a coarse file system) still differ by size.
    const settings = join(root, "agent", "settings.json");
    const at = new Date(2026, 0, 1);
    await utimes(settings, at, at);
    previous = await piInputs(cwd);
    await writeFile(settings, '{ "defaultModel": "sonnet" }');
    await utimes(settings, at, at);
    expect(await piInputs(cwd)).not.toBe(previous);
    previous = await piInputs(cwd);
    // A file pi does not read at start changes nothing.
    await writeFile(join(cwd, "README.md"), "hi");
    expect(await piInputs(cwd)).toBe(previous);
  });
});

describe("pi's settings.json", () => {
  const file = () => join(root, "agent", "settings.json");

  it("changes the Settings page's keys and keeps the rest of the file", async () => {
    await writeFile(file(), JSON.stringify({ packages: ["npm:x"], compaction: { modelOverrides: {} }, defaultModel: "a" }), { mode: 0o600 });
    const state = await writePiSettings({ defaultModel: "claude-opus-5-5", "compaction.enabled": false });
    expect(state.values).toEqual({ defaultModel: "claude-opus-5-5", "compaction.enabled": false });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ packages: ["npm:x"], compaction: { modelOverrides: {}, enabled: false }, defaultModel: "claude-opus-5-5" });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readPiSettings()).toEqual({ path: file(), values: state.values });
  });

  it("starts the file when there is none, and writes through a symlink", async () => {
    await writePiSettings({ cacheWarming: "off" });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ cacheWarming: "off" });
    const dotfiles = join(root, "dotfiles.json");
    await rm(file());
    await writeFile(dotfiles, "{}");
    await symlink(dotfiles, file());
    await writePiSettings({ steeringMode: "all" });
    expect((await lstat(file())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(dotfiles, "utf8"))).toEqual({ steeringMode: "all" });
  });

  it("never writes over a file it cannot read, and reports why", async () => {
    await writeFile(file(), "{ broken");
    await expect(writePiSettings({ cacheWarming: "off" })).rejects.toThrow("not valid JSON");
    expect(await readFile(file(), "utf8")).toBe("{ broken");
    expect((await readPiSettings()).problem).toContain("not valid JSON");
  });

  it("waits for pi's lock, and takes over a stale one", async () => {
    await mkdir(`${file()}.lock`);
    const write = writePiSettings({ cacheWarming: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(`${file()}.lock`, { recursive: true });
    await write;
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ cacheWarming: "idle" });

    await mkdir(`${file()}.lock`);
    await expect(writePiSettings({ cacheWarming: "off" })).rejects.toThrow("try again");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file()}.lock`, old, old);
    await writePiSettings({ cacheWarming: "off" });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ cacheWarming: "off" });
    await expect(stat(`${file()}.lock`)).rejects.toThrow();
  });
});
