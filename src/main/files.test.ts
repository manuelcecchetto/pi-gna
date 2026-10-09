import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// Real rg, counted; the watcher is the real one, or one the test fires.
const hooks = vi.hoisted(() => ({ spawns: 0, fake: true, watchers: [] as { cwd: string; fire: (event: string, name: string | null) => void; error: () => void; closed: boolean }[] }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => (hooks.spawns++, real.spawn(...args)) };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const watch = (cwd: string, options: { recursive: boolean }, listener: (event: string, name: string | null) => void) => {
    if (!hooks.fake) return real.watch(cwd, options, listener);
    const watcher = Object.assign(new EventEmitter(), { close: () => void (entry.closed = true) });
    const entry = { cwd, fire: listener, error: () => watcher.emit("error", new Error("gone")), closed: false };
    hooks.watchers.push(entry);
    return watcher;
  };
  return { ...real, watch };
});

let roots: string[] = [];
const project = async (...files: string[]) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pigna-files-")));
  for (const file of ["a.ts", ...files]) await writeFile(join(root, file), "");
  roots.push(root);
  return root;
};
const watcherOf = (cwd: string) => hooks.watchers.filter((watcher) => watcher.cwd === cwd).at(-1);

const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;

beforeEach(() => {
  // A module of its own per test: its lists and watchers start empty.
  vi.resetModules();
  hooks.spawns = 0;
  hooks.fake = true;
  hooks.watchers = [];
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

describe("listFiles", () => {
  it("lists the project once while nothing changes, and again after a file appears", async () => {
    hooks.fake = false;
    const { listFiles } = await import("./files");
    const root = await project();
    // FSEvents may still report the folder's creation to a watcher started right after it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await listFiles(root)).toEqual(["a.ts"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    vi.setSystemTime(Date.now() + 60_000);
    expect(await listFiles(root)).toEqual(["a.ts"]);
    expect(hooks.spawns).toBe(1);
    await writeFile(join(root, "b.ts"), "");
    await vi.waitFor(async () => expect((await listFiles(root)).sort()).toEqual(["a.ts", "b.ts"]), { timeout: 5000 });
    expect(hooks.spawns).toBe(2);
  });

  it("keeps the list through edits and git's own files, and drops it when a file comes or goes or an ignore file changes", async () => {
    const { listFiles } = await import("./files");
    const root = await project();
    await listFiles(root);
    const watcher = watcherOf(root);
    watcher?.fire("change", "a.ts");
    watcher?.fire("rename", ".git/index.lock");
    watcher?.fire("rename", ".git");
    await listFiles(root);
    expect(hooks.spawns).toBe(1);
    watcher?.fire("rename", "src/new.ts");
    expect(watcher?.closed).toBe(true);
    await listFiles(root);
    expect(hooks.spawns).toBe(2);
    watcherOf(root)?.fire("change", "web/.gitignore");
    await listFiles(root);
    expect(hooks.spawns).toBe(3);
    watcherOf(root)?.error();
    await listFiles(root);
    expect(hooks.spawns).toBe(4);
  });

  it("keeps eight projects' lists, dropping the least recently used", async () => {
    const { listFiles } = await import("./files");
    const projects = await Promise.all(Array.from({ length: 9 }, () => project()));
    for (const root of projects.slice(0, 8)) await listFiles(root);
    await listFiles(projects[0] as string);
    await listFiles(projects[8] as string);
    expect(hooks.spawns).toBe(9);
    expect(watcherOf(projects[1] as string)?.closed).toBe(true);
    expect(hooks.watchers.filter((watcher) => !watcher.closed)).toHaveLength(8);
    await listFiles(projects[0] as string);
    expect(hooks.spawns).toBe(9);
  });

  it("lists again after 15 s where it cannot watch, and when rg failed", async () => {
    const { listFiles } = await import("./files");
    const root = await project();
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.resetModules();
    const linux = await import("./files");
    Object.defineProperty(process, "platform", platform);
    await linux.listFiles(root);
    expect(hooks.watchers).toHaveLength(0);
    vi.setSystemTime(Date.now() + 14_000);
    await linux.listFiles(root);
    expect(hooks.spawns).toBe(1);
    vi.setSystemTime(Date.now() + 2000);
    await linux.listFiles(root);
    expect(hooks.spawns).toBe(2);

    // No rg on PATH: an empty list, which expires.
    vi.stubEnv("PATH", "/nonexistent");
    const other = await project();
    expect(await listFiles(other)).toEqual([]);
    expect(watcherOf(other)?.closed).toBe(true);
    vi.unstubAllEnvs();
    vi.setSystemTime(Date.now() + 16_000);
    expect(await listFiles(other)).toEqual(["a.ts"]);
  });
});
