import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostError } from "../shared/host-api";
import type { PriceTable, UsageProgress } from "../shared/usage";
import { extractFileUsage } from "./usage-extract";
import type { Extractor } from "./usage-index";
import { parseUsageQuery, UsageService } from "./usage-service";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const DAY = 86_400_000;
const PRICES: PriceTable = { source: "test", asOf: "2026-10-10", entries: [] };
const at = (ms: number) => new Date(ms).toISOString();

let seq = 0;
const nextId = () => `e${(seq++).toString(16).padStart(6, "0")}`;

function chat(id: string, options: { cwd?: string; model?: string; turns?: number; system?: string } = {}): string {
  const { cwd = "/Users/me/Code/app", model = "claude-sonnet-5-5", turns = 2, system } = options;
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: at(T0), cwd })];
  if (system !== undefined) lines.push(JSON.stringify({ type: "message", id: nextId(), parentId: null, timestamp: at(T0), message: { role: "system", content: system } }));
  let time = T0;
  for (let n = 0; n < turns; n++) {
    time += 1000;
    lines.push(JSON.stringify({ type: "message", id: nextId(), parentId: null, timestamp: at(time), message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: time } }));
    time += 1000;
    const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "test", provider: "anthropic", model, usage, stopReason: "stop", timestamp: time };
    lines.push(JSON.stringify({ type: "message", id: nextId(), parentId: null, timestamp: at(time), message }));
  }
  return `${lines.join("\n")}\n`;
}

const spy = (calls: string[]): Extractor => ({
  extract: async (target, previous) => {
    calls.push(target.path);
    return extractFileUsage(target, previous);
  },
  close: async () => undefined,
});

let dir: string;
let sessions: string;
let atp: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-service-"));
  sessions = join(dir, "sessions");
  atp = join(dir, "atp");
  file = join(dir, "usage-index.json");
  await mkdir(join(sessions, "app"), { recursive: true });
  await mkdir(atp, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(options: { piDirs?: Promise<void>; calls?: string[]; events?: UsageProgress[] } = {}): UsageService {
  return new UsageService({
    roots: () => ({ sessions, atp }),
    piDirs: options.piDirs ?? Promise.resolve(),
    file,
    openExtractor: () => spy(options.calls ?? []),
    concurrency: 2,
    publish: (progress) => options.events?.push(progress),
    prices: () => PRICES,
    now: () => NOW,
  });
}

describe("parseUsageQuery", () => {
  it("defaults to 30 days of pi-gna surfaces", () => {
    expect(parseUsageQuery(undefined)).toEqual({ range: "30d", source: "pigna" });
  });

  it("keeps presets, custom spans, the project and the zone", () => {
    const query = { range: { from: T0, to: T0 + DAY }, source: "all", project: "/Users/me/Code/app", timeZone: "Europe/Rome" };
    expect(parseUsageQuery(query)).toEqual(query);
    expect(parseUsageQuery({ range: "all", source: "pigna" })).toEqual({ range: "all", source: "pigna" });
  });

  it("refuses what the report cannot take, as bad requests", () => {
    const bad: unknown[] = [
      null,
      "30d",
      { range: "1y", source: "pigna" },
      { range: "7d", source: "both" },
      { range: { from: T0, to: T0 }, source: "all" },
      { range: { from: 0, to: NOW }, source: "all" },
      { range: { from: Number.NaN, to: NOW }, source: "all" },
      { range: "7d", source: "all", timeZone: "Mars/Olympus" },
      { range: "7d", source: "all", project: "x".repeat(2000) },
    ];
    for (const query of bad) expect(() => parseUsageQuery(query), JSON.stringify(query)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => parseUsageQuery({ range: "7d", source: "all" })).not.toThrow();
    expect(new HostError("bad_request", "x").status).toBe(400);
  });
});

describe("UsageService", () => {
  it("reports pi-gna's surfaces by default and everything on request", async () => {
    await writeFile(join(sessions, "app", "a.jsonl"), chat("a", { system: "tools: kanban_add", turns: 2 }));
    await writeFile(join(sessions, "app", "b.jsonl"), chat("b", { turns: 3 }));
    const svc = service();
    const pigna = await svc.get({ range: "30d", source: "pigna" });
    expect(pigna.totals.turns).toBe(2);
    expect(pigna.meta).toMatchObject({ files: 2, indexedFiles: 1, source: "pigna", timeZone: pigna.meta.timeZone });
    const all = await svc.get({ range: "30d", source: "all" });
    expect(all.totals.turns).toBe(5);
    expect(all.meta.indexedFiles).toBe(2);
  });

  it("waits for pi's folders before it reads any file", async () => {
    await writeFile(join(sessions, "app", "a.jsonl"), chat("a"));
    let release = (): void => undefined;
    const piDirs = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const pending = service({ piDirs, calls }).get({ range: "30d", source: "all" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    release();
    expect((await pending).totals.turns).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("scans once per launch and serves later reports from memory", async () => {
    await writeFile(join(sessions, "app", "a.jsonl"), chat("a"));
    const calls: string[] = [];
    const events: UsageProgress[] = [];
    const svc = service({ calls, events });
    await svc.get({ range: "30d", source: "all" });
    const after = events.length;
    expect(events.at(-1)).toEqual({ phase: "done", done: 1, total: 1 });
    await writeFile(join(sessions, "app", "b.jsonl"), chat("b"));
    const again = await svc.get({ range: "30d", source: "all" });
    expect(again.meta.files).toBe(1);
    expect(events).toHaveLength(after);
    expect(calls).toHaveLength(1);
  });

  it("refresh reads the files written since the scan", async () => {
    await writeFile(join(sessions, "app", "a.jsonl"), chat("a"));
    const calls: string[] = [];
    const svc = service({ calls });
    await svc.get({ range: "30d", source: "all" });
    await writeFile(join(sessions, "app", "b.jsonl"), chat("b", { turns: 3 }));
    await svc.refresh();
    const report = await svc.get({ range: "30d", source: "all" });
    expect(report.meta.files).toBe(2);
    expect(report.totals.turns).toBe(5);
    expect(calls).toHaveLength(2);
  });

  it("joins a refresh asked while a scan runs", async () => {
    await writeFile(join(sessions, "app", "a.jsonl"), chat("a"));
    const events: UsageProgress[] = [];
    const svc = service({ events });
    await Promise.all([svc.refresh(), svc.refresh(), svc.get({ range: "30d", source: "all" })]);
    expect(events.filter((event) => event.phase === "scan")).toHaveLength(1);
  });

  it("reuses the cache on the next launch", async () => {
    await writeFile(join(sessions, "app", "a.jsonl"), chat("a", { turns: 2 }));
    const first = await service().get({ range: "30d", source: "all" });
    const calls: string[] = [];
    const second = await service({ calls }).get({ range: "30d", source: "all" });
    expect(calls).toEqual([]);
    expect(second.totals).toEqual(first.totals);
  });

  it("bounds the models and projects it sends, and still counts every row in the totals", async () => {
    for (let i = 0; i < 55; i++) {
      await writeFile(join(sessions, "app", `s${i}.jsonl`), chat(`s${i}`, { cwd: `/Users/me/Code/p${i}`, model: `m${i % 35}`, turns: 1 }));
    }
    const report = await service().get({ range: "30d", source: "all" });
    expect(report.totals.sessions).toBe(55);
    expect(report.totals.turns).toBe(55);
    expect(report.models).toHaveLength(30);
    expect(report.projects).toHaveLength(50);
  });

  it("throttles progress events while files are read", async () => {
    for (let i = 0; i < 20; i++) await writeFile(join(sessions, "app", `s${i}.jsonl`), chat(`s${i}`, { turns: 1 }));
    const events: UsageProgress[] = [];
    await service({ events }).get({ range: "30d", source: "all" });
    const indexing = events.filter((event) => event.phase === "index");
    expect(indexing.length).toBeLessThan(20);
    expect(events[0]).toEqual({ phase: "scan", done: 0, total: 0 });
    expect(events.at(-1)).toEqual({ phase: "done", done: 20, total: 20 });
  });
});
