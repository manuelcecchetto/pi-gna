import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileUsageFacts, USAGE_FACTS_VERSION } from "../shared/usage";
import { type Extractor, type IndexProgress, UsageIndex } from "./usage-index";
import { extractFileUsage } from "./usage-extract";

const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const CWD = "/Users/me/Code/app";

let seq = 0;
const nextId = () => `e${(seq++).toString(16).padStart(6, "0")}`;

function turnLines(start: number, turns: number, model = "claude-sonnet-5-5"): string[] {
  const lines: string[] = [];
  let time = start;
  for (let n = 0; n < turns; n++) {
    time += 1000;
    lines.push(JSON.stringify({ type: "message", id: nextId(), parentId: null, timestamp: at(time), message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: time } }));
    time += 1000;
    const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    lines.push(
      JSON.stringify({
        type: "message",
        id: nextId(),
        parentId: null,
        timestamp: at(time),
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "test", provider: "anthropic", model, usage, stopReason: "stop", timestamp: time },
      }),
    );
  }
  return lines;
}

function chatLines(id: string, turns: number, options: { cwd?: string; model?: string; header?: Record<string, unknown>; system?: string } = {}): string[] {
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: at(T0), cwd: options.cwd ?? CWD, ...options.header });
  const system =
    options.system === undefined
      ? []
      : [JSON.stringify({ type: "message", id: nextId(), parentId: null, timestamp: at(T0), message: { role: "system", content: options.system } })];
  return [header, ...system, ...turnLines(T0, turns, options.model)];
}

const join_ = (lines: string[]) => `${lines.join("\n")}\n`;

let dir: string;
let sessions: string;
let atp: string;
let cacheFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-index-"));
  sessions = join(dir, "sessions");
  atp = join(dir, "atp");
  cacheFile = join(dir, "usage-index.json");
  await mkdir(join(sessions, "proj"), { recursive: true });
  await mkdir(atp, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a file and gives it an mtime, so a rewrite is seen even within one millisecond. */
async function put(path: string, text: string, mtime: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await utimes(path, new Date(mtime), new Date(mtime));
}

interface Call {
  path: string;
  resumed: boolean;
}

function spyExtractor(calls: Call[], failing = new Set<string>()): () => Extractor {
  return () => ({
    extract: async (target, previous) => {
      calls.push({ path: target.path, resumed: previous !== undefined });
      if (failing.has(target.path)) throw new Error("unreadable");
      return extractFileUsage(target, previous);
    },
    close: async () => undefined,
  });
}

function open(calls: Call[], failing?: Set<string>): UsageIndex {
  return new UsageIndex({ roots: () => ({ sessions, atp }), file: cacheFile, openExtractor: spyExtractor(calls, failing), concurrency: 2 });
}

const byId = (facts: FileUsageFacts[]) => [...facts].sort((a, b) => a.session.id.localeCompare(b.session.id));
const pathsIn = (facts: FileUsageFacts[]) => facts.map((f) => f.session.path).sort();

describe("UsageIndex", () => {
  it("extracts every session file on the first run and reports progress", async () => {
    await put(join(sessions, "proj", "a.jsonl"), join_(chatLines("sess-a", 2)), T0);
    await put(join(sessions, "proj", "b.jsonl"), join_(chatLines("sess-b", 1)), T0);
    await put(join(atp, "w.jsonl"), join_(chatLines("sess-w", 1)), T0);
    const calls: Call[] = [];
    const progress: IndexProgress[] = [];
    const index = open(calls);

    await index.ensureIndexed((step) => progress.push(step));

    expect(byId(index.allFacts()).map((f) => [f.session.id, f.session.root])).toEqual([
      ["sess-a", "sessions"],
      ["sess-b", "sessions"],
      ["sess-w", "atp"],
    ]);
    expect(calls).toHaveLength(3);
    expect(progress.at(-1)).toMatchObject({ done: 3, total: 3 });
    expect(progress.at(-1)?.bytes).toBeGreaterThan(0);
  });

  it("does not read a file again when its size and mtime are unchanged", async () => {
    await put(join(sessions, "proj", "a.jsonl"), join_(chatLines("sess-a", 1)), T0);
    const first = open([]);
    await first.ensureIndexed();

    const calls: Call[] = [];
    await open(calls).ensureIndexed();

    expect(calls).toEqual([]);
    expect(first.allFacts()).toHaveLength(1);
  });

  it("resumes a grown file from the cache and matches a full read", async () => {
    const path = join(sessions, "proj", "a.jsonl");
    await put(path, join_(chatLines("sess-a", 2)), T0);
    await open([]).ensureIndexed();

    await appendFile(path, join_(turnLines(T0 + 10_000, 2)));
    await utimes(path, new Date(T0 + 20_000), new Date(T0 + 20_000));
    const calls: Call[] = [];
    const index = open(calls);
    await index.ensureIndexed();

    expect(calls).toEqual([{ path, resumed: true }]);
    const full = await extractFileUsage({ root: "sessions", path });
    expect(index.allFacts()).toEqual([full]);
  });

  it("reads a rewritten file in full when its size is unchanged", async () => {
    const path = join(sessions, "proj", "a.jsonl");
    await put(path, join_(chatLines("sess-a", 1, { model: "claude-sonnet-5-5" })), T0);
    await open([]).ensureIndexed();

    await put(path, join_(chatLines("sess-a", 1, { model: "claude-sonnet-5-6" })), T0 + 5_000);
    const calls: Call[] = [];
    const index = open(calls);
    await index.ensureIndexed();

    expect(calls).toEqual([{ path, resumed: false }]);
    expect(index.allFacts()[0]?.buckets.map((bucket) => bucket.model)).toEqual(["claude-sonnet-5-6"]);
  });

  it("reads a grown file in full when its head changed", async () => {
    const path = join(sessions, "proj", "a.jsonl");
    await put(path, join_(chatLines("sess-a", 1)), T0);
    await open([]).ensureIndexed();

    await put(path, join_(chatLines("sess-a", 3, { cwd: "/Users/me/Code/other" })), T0 + 5_000);
    const calls: Call[] = [];
    const index = open(calls);
    await index.ensureIndexed();

    expect(calls).toEqual([{ path, resumed: false }]);
    expect(index.allFacts()[0]?.session.cwd).toBe("/Users/me/Code/other");
  });

  it("drops a deleted file from the facts and the cache", async () => {
    const kept = join(sessions, "proj", "a.jsonl");
    const removed = join(sessions, "proj", "b.jsonl");
    await put(kept, join_(chatLines("sess-a", 1)), T0);
    await put(removed, join_(chatLines("sess-b", 1)), T0);
    await open([]).ensureIndexed();

    await rm(removed);
    const index = open([]);
    await index.ensureIndexed();

    expect(pathsIn(index.allFacts())).toEqual([kept]);
    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { entries: [string, unknown][] };
    expect(saved.entries.map(([path]) => path)).toEqual([kept]);
  });

  it("reuses the cache across instances", async () => {
    await put(join(sessions, "proj", "a.jsonl"), join_(chatLines("sess-a", 2)), T0);
    const first = open([]);
    await first.ensureIndexed();

    const calls: Call[] = [];
    const second = open(calls);
    await second.ensureIndexed();

    expect(calls).toEqual([]);
    expect(second.allFacts()).toEqual(first.allFacts());
  });

  it("rebuilds from the files when the cache has another version or is damaged", async () => {
    await put(join(sessions, "proj", "a.jsonl"), join_(chatLines("sess-a", 1)), T0);
    await open([]).ensureIndexed();

    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { version: number; entries: unknown[] };
    await writeFile(cacheFile, JSON.stringify({ ...saved, version: USAGE_FACTS_VERSION - 1 }));
    const older: Call[] = [];
    await open(older).ensureIndexed();
    expect(older).toEqual([{ path: join(sessions, "proj", "a.jsonl"), resumed: false }]);

    await writeFile(cacheFile, "{not json");
    const damaged: Call[] = [];
    const index = open(damaged);
    await index.ensureIndexed();
    expect(damaged).toHaveLength(1);
    expect(index.allFacts()).toHaveLength(1);
  });

  it("counts a session once when two files hold the same session id", async () => {
    await put(join(sessions, "proj", "short.jsonl"), join_(chatLines("sess-d", 1)), T0);
    await put(join(sessions, "proj", "long.jsonl"), join_(chatLines("sess-d", 2)), T0);
    const index = open([]);
    await index.ensureIndexed();

    const facts = index.allFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.session.path).toBe(join(sessions, "proj", "long.jsonl"));
    expect(facts[0]?.prompts.count).toBe(2);
  });

  it("classifies a subagent as pi-gna when its parent is", async () => {
    const parent = join(sessions, "proj", "p.jsonl");
    const pignaSub = join(sessions, "proj", "p", "tasks", "s.jsonl");
    const terminalParent = join(sessions, "proj", "q.jsonl");
    const terminalSub = join(sessions, "proj", "q", "tasks", "t.jsonl");
    await put(parent, join_(chatLines("parent-p", 1, { system: "Use kanban_list for cards." })), T0);
    await put(pignaSub, join_(chatLines("sub-s", 1, { header: { parentSession: "parent-p" } })), T0);
    await put(terminalParent, join_(chatLines("parent-q", 1)), T0);
    await put(terminalSub, join_(chatLines("sub-t", 1, { header: { parentSession: "parent-q" } })), T0);

    const index = open([]);
    await index.ensureIndexed();

    const byPath = new Map(index.allFacts().map((f) => [f.session.path, f.session]));
    expect(byPath.get(parent)?.pigna).toBe(true);
    expect(byPath.get(pignaSub)).toMatchObject({ surface: "subagent", pigna: true });
    expect(byPath.get(terminalSub)).toMatchObject({ surface: "subagent", pigna: false });
  });

  it("skips a file whose extraction fails and indexes the rest", async () => {
    const broken = join(sessions, "proj", "broken.jsonl");
    await put(broken, join_(chatLines("sess-x", 1)), T0);
    await put(join(sessions, "proj", "ok.jsonl"), join_(chatLines("sess-y", 1)), T0);
    const index = open([], new Set([broken]));

    await index.ensureIndexed();

    expect(index.allFacts().map((f) => f.session.id)).toEqual(["sess-y"]);
  });

  it("refreshes one file after it settles without a full scan", async () => {
    const path = join(sessions, "proj", "a.jsonl");
    await put(path, join_(chatLines("sess-a", 1)), T0);
    const index = open([]);
    await index.ensureIndexed();

    await appendFile(path, join_(turnLines(T0 + 10_000, 1)));
    await utimes(path, new Date(T0 + 20_000), new Date(T0 + 20_000));
    const calls: Call[] = [];
    const refreshed = open(calls);
    await refreshed.ensureIndexed();
    await refreshed.refreshFile(path);
    expect(calls).toEqual([{ path, resumed: true }]);
    expect(refreshed.allFacts()[0]?.prompts.count).toBe(2);
  });
});
