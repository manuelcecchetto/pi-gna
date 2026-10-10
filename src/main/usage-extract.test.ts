import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileUsageFacts, UsageBucket } from "../shared/usage";
import { extractFileUsage } from "./usage-extract";

const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();

let seq = 0;
const nextId = () => (seq++).toString(16).padStart(8, "0");

const header = () => ({ type: "session", version: 3, id: "sess-1", timestamp: at(T0), cwd: "/Users/me/Code/app" });

function entry(type: string, time: number, fields: Record<string, unknown>) {
  return { type, id: nextId(), parentId: null, timestamp: at(time), ...fields };
}

const userMsg = (time: number, text = "hi") =>
  entry("message", time, { message: { role: "user", content: [{ type: "text", text }], timestamp: time } });

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

interface TurnOptions {
  calls?: [id: string, name: string][];
  usage?: ReturnType<typeof usage>;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

function turn(time: number, options: TurnOptions = {}) {
  const content = [
    ...(options.calls ?? []).map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
    { type: "text", text: "ok" },
  ];
  return entry("message", time, {
    message: {
      role: "assistant",
      content,
      api: "test",
      provider: options.provider ?? "anthropic",
      model: options.model ?? "claude-sonnet-5-5",
      usage: options.usage ?? usage(1000, 100),
      stopReason: options.stopReason ?? "stop",
      errorMessage: options.errorMessage,
      thinkingLevel: options.thinkingLevel,
      timestamp: time,
    },
  });
}

function result(time: number, toolCallId: string, toolName: string, extra: { isError?: boolean; nestedCalls?: unknown } = {}) {
  return entry("message", time, {
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "output" }],
      isError: extra.isError ?? false,
      nestedCalls: extra.nestedCalls,
      timestamp: time,
    },
  });
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-extract-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRecords(name: string, records: unknown[], trailingLf = true): Promise<string> {
  const path = join(dir, name);
  const text = records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n");
  await writeFile(path, trailingLf ? `${text}\n` : text);
  return path;
}

const extract = (path: string, previous?: FileUsageFacts) => extractFileUsage({ root: "sessions", path }, previous);

async function read(name: string, records: unknown[]): Promise<FileUsageFacts> {
  const facts = await extract(await writeRecords(name, records));
  if (!facts) throw new Error(`no session header in ${name}`);
  return facts;
}

const sumTurns = (facts: FileUsageFacts) => facts.buckets.reduce((sum, bucket) => sum + bucket.turns, 0);

describe("extractFileUsage", () => {
  it("pairs a tool call with its result by toolCallId", async () => {
    const facts = await read("round-trip.jsonl", [
      header(),
      userMsg(T0),
      turn(T0 + 1000, { calls: [["c1", "read"]], stopReason: "toolUse" }),
      result(T0 + 9000, "c1", "read"),
      turn(T0 + 10_000),
    ]);
    expect(facts.tools).toEqual({ read: { calls: 1, errors: 0, timedCalls: 1, durationMs: 8000, nestedCalls: 0 } });
    expect(facts.stops).toEqual({ toolUse: 1, stop: 1 });
    expect(facts.prompts).toMatchObject({ count: 1, steps: 2, toolCalls: 1, aborted: 0 });
    expect(facts.resume.pending).toEqual({});
  });

  it("times parallel calls from the same turn each against its own result", async () => {
    const facts = await read("parallel.jsonl", [
      header(),
      userMsg(T0),
      turn(T0 + 1000, { calls: [["c1", "bash"], ["c2", "read"]], stopReason: "toolUse" }),
      result(T0 + 4000, "c2", "read"),
      result(T0 + 6000, "c1", "bash", { isError: true }),
      turn(T0 + 7000, { calls: [["c3", "codemode"]], stopReason: "toolUse" }),
      result(T0 + 8000, "c3", "codemode", { nestedCalls: { calls: [{ id: "c3/1" }, { id: "c3/2" }] } }),
    ]);
    expect(facts.tools.bash).toEqual({ calls: 1, errors: 1, timedCalls: 1, durationMs: 5000, nestedCalls: 0 });
    expect(facts.tools.read).toEqual({ calls: 1, errors: 0, timedCalls: 1, durationMs: 3000, nestedCalls: 0 });
    expect(facts.tools.codemode).toEqual({ calls: 1, errors: 0, timedCalls: 1, durationMs: 1000, nestedCalls: 2 });
    expect(facts.prompts.toolCalls).toBe(3);
  });

  it("classifies error and aborted turns and marks a prompt aborted by its last turn", async () => {
    const facts = await read("errors.jsonl", [
      header(),
      userMsg(T0),
      turn(T0 + 1000, { stopReason: "error", errorMessage: "503 Service Unavailable" }),
      turn(T0 + 2000, { stopReason: "error", errorMessage: "Claude Code process terminated by signal SIGKILL" }),
      userMsg(T0 + 3000),
      turn(T0 + 4000, { stopReason: "aborted", errorMessage: "Operation aborted" }),
    ]);
    expect(facts.errors).toEqual({ overloaded: 1, process: 1, aborted: 1 });
    expect(facts.stops).toEqual({ error: 2, aborted: 1 });
    expect(facts.buckets.reduce((sum, bucket) => sum + bucket.errorTurns, 0)).toBe(3);
    expect(facts.prompts).toMatchObject({ count: 2, aborted: 1, steps: 3, stepHist: [1, 1, 0, 0, 0, 0, 0] });
  });

  it("counts compactions and context edits", async () => {
    const facts = await read("compaction.jsonl", [
      header(),
      userMsg(T0),
      turn(T0 + 1000),
      entry("compaction", T0 + 2000, { summary: "s", firstKeptEntryId: "x", tokensBefore: 120_000 }),
      entry("context_edit", T0 + 2500, { targetId: "x", replacement: null }),
      userMsg(T0 + 3000),
    ]);
    expect(facts.compactions).toBe(1);
    expect(facts.compactedTokens).toBe(120_000);
    expect(facts.contextEdits).toBe(1);
    expect(facts.prompts.count).toBe(2);
  });

  it("counts turns on an abandoned branch as billed", async () => {
    const facts = await read("branch.jsonl", [
      header(),
      { ...userMsg(T0), id: "u1", parentId: null },
      { ...turn(T0 + 1000), id: "a1", parentId: "u1" },
      { ...turn(T0 + 2000, { model: "abandoned" }), id: "a2", parentId: "u1" },
      { ...userMsg(T0 + 3000), id: "u2", parentId: "a1" },
    ]);
    expect(sumTurns(facts)).toBe(2);
    expect(facts.buckets.map((bucket) => bucket.model).sort()).toEqual(["abandoned", "claude-sonnet-5-5"]);
    expect(facts.prompts).toMatchObject({ count: 2, steps: 2, stepHist: [1, 1, 0, 0, 0, 0, 0] });
  });

  it("buckets turns by UTC hour and keeps tier, cache-miss and context-histogram counts", async () => {
    const facts = await read("hours.jsonl", [
      header(),
      userMsg(T0),
      turn(T0 + 1000, { provider: "openai-codex", model: "gpt-5.5", usage: usage(300_000, 500) }),
      turn(T0 + HOUR + 1000, { usage: usage(1000, 10, 50_000) }),
    ]);
    expect(facts.buckets).toHaveLength(2);
    const [first, second] = facts.buckets as [UsageBucket, UsageBucket];
    expect(first).toMatchObject({ hour: Math.floor(T0 / HOUR), provider: "openai-codex", model: "gpt-5.5", missTurns: 1 });
    expect(first.tierTokens).toMatchObject({ input: 300_000, output: 500 });
    expect(second).toMatchObject({ hour: Math.floor(T0 / HOUR) + 1, missTurns: 0 });
    expect(second.tierTokens.input).toBe(0);
    expect(facts.contextHist).toEqual([0, 0, 1, 0, 0, 0, 1, 0, 0]);
  });

  it("caps each gap between entries at five minutes for active time and prompt wall time", async () => {
    const facts = await read("active.jsonl", [
      header(),
      userMsg(T0),
      turn(T0 + 60_000),
      turn(T0 + 60_000 + 10 * 60_000),
    ]);
    expect(facts.session).toMatchObject({ firstAt: T0, lastAt: T0 + 11 * 60_000, activeMs: 6 * 60_000 });
    expect(facts.prompts.wallMs).toBe(6 * 60_000);
  });

  it("counts subagent runs by status and session names, and reads the latest name", async () => {
    const facts = await read("subagents.jsonl", [
      header(),
      userMsg(T0),
      entry("custom", T0 + 1000, { customType: "subagents:record", data: { id: "r1", status: "completed" } }),
      entry("custom", T0 + 2000, { customType: "codemode-store", data: { set: {} } }),
      entry("session_info", T0 + 3000, { name: "first" }),
      entry("session_info", T0 + 4000, { name: "renamed" }),
    ]);
    expect(facts.subagentRuns).toEqual({ completed: 1 });
    expect(facts.session.name).toBe("renamed");
  });

  it("skips bad lines and unknown entries without throwing, and ignores role text inside strings", async () => {
    const fakeRole = `Quote: {"role":"assistant","content":[]}`;
    const facts = await read("bad.jsonl", [
      header(),
      "not json {",
      { type: "mystery", id: "m1", parentId: null, timestamp: at(T0) },
      userMsg(T0, fakeRole),
      entry("message", T0 + 500, { message: { role: "system", content: "x".repeat(200_000) } }),
      entry("message", T0 + 600, { message: { role: "bashExecution", command: "ls", output: "", exitCode: 0 } }),
    ]);
    expect(facts.skipped).toEqual({ lines: 1, entries: 1 });
    expect(sumTurns(facts)).toBe(0);
    expect(facts.prompts.count).toBe(1);
  });

  it("returns undefined for a file without a session header", async () => {
    const path = await writeRecords("no-header.jsonl", [userMsg(T0)]);
    expect(await extract(path)).toBeUndefined();
  });

  it("reads an unterminated last line only once it parses", async () => {
    const torn = JSON.stringify(turn(T0 + 1000, { calls: [["c1", "read"]], stopReason: "toolUse" })).slice(0, 40);
    const path = await writeRecords("torn.jsonl", [header(), userMsg(T0), torn], false);
    const facts = await extract(path);
    expect(facts?.consumedBytes).toBe((await stat(path)).size - torn.length);
    expect(facts?.skipped.lines).toBe(0);
    expect(facts?.prompts.count).toBe(1);
  });

  it("merges an append into the previous facts exactly as a full read would", async () => {
    const records = [
      header(),
      userMsg(T0),
      turn(T0 + 1000, { calls: [["c1", "read"]], stopReason: "toolUse", thinkingLevel: "high" }),
      result(T0 + 9000, "c1", "read"),
      turn(T0 + 10_000, { thinkingLevel: "low", usage: usage(300_000, 100, 0, 5000) }),
      entry("compaction", T0 + 11_000, { summary: "s", firstKeptEntryId: "x", tokensBefore: 90_000 }),
      userMsg(T0 + 20_000),
      entry("custom", T0 + 21_000, { customType: "subagents:record", data: { status: "stopped" } }),
      turn(T0 + 22_000, { calls: [["c2", "codemode"]], stopReason: "toolUse" }),
      result(T0 + 30_000, "c2", "codemode", { nestedCalls: { calls: [{ id: "c2/1" }] } }),
    ];
    const lines = records.map((record) => JSON.stringify(record));
    const firstPart = Buffer.from(`${lines.slice(0, 3).join("\n")}\n`);
    const full = Buffer.from(`${lines.join("\n")}\n`);
    const cut = firstPart.length + 10;
    const path = join(dir, "append.jsonl");

    await writeFile(path, full.subarray(0, cut));
    const previous = await extract(path);
    expect(previous?.consumedBytes).toBe(firstPart.length);
    expect(previous?.resume.pending).toEqual({ c1: { name: "read", at: T0 + 1000 } });

    await writeFile(path, full);
    const incremental = await extract(path, previous);
    const fresh = await extract(path);
    expect(incremental?.consumedBytes).toBe(full.length);
    expect(withoutFileStat(incremental)).toEqual(withoutFileStat(fresh));
    expect(fresh?.resume.pending).toEqual({});
    expect(fresh?.subagentRuns).toEqual({ stopped: 1 });
    expect(fresh?.tools.codemode?.nestedCalls).toBe(1);
  });
});

function withoutFileStat(facts: FileUsageFacts | undefined): FileUsageFacts {
  if (!facts) throw new Error("no facts");
  return { ...facts, size: 0, mtimeMs: 0 };
}
