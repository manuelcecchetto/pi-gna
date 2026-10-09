import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, SessionEntry } from "../shared/protocol";
import { responsePreview } from "../shared/push-rules";
import { createSession, hydrate, type Item, runOutcome } from "../shared/session-state";
import { EVICT_BYTES, evictPayloads, KEPT_TURNS, PayloadFiles, restorePayloads } from "./payloads";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./log", () => ({ log: { info: () => undefined, warn, error: () => undefined } }));

const png = (size: number) => ({ type: "image" as const, mimeType: "image/png", data: "i".repeat(size) });
let entryId = 0;
/** A session-file entry as pi writes it: type, id, parentId and timestamp, then the message, its role first. */
const entry = (message: AgentMessage): SessionEntry => ({ type: "message", id: `e${++entryId}`, parentId: entryId > 1 ? `e${entryId - 1}` : null, timestamp: new Date(1_000 + entryId).toISOString(), message }) as SessionEntry;
/** Turn `n`: a prompt (with an image for n % 3 == 0), a tool call and its result (big for even n, with an image for n % 4 == 1), an answer. */
function turn(n: number, size = EVICT_BYTES): SessionEntry[] {
  const text = n % 2 === 0 ? "x".repeat(size) : `small ${n}`;
  return [
    entry({ role: "user", content: n % 3 === 0 ? [{ type: "text", text: `q${n}` }, png(2_000)] : `q${n}`, timestamp: n * 10 }),
    entry({ role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", timestamp: n * 10 + 1 } as unknown as AgentMessage),
    entry({ role: "toolResult", toolCallId: `t${n}`, toolName: "bash", content: n % 4 === 1 ? [{ type: "text", text }, png(500)] : [{ type: "text", text }], details: { n }, isError: false, timestamp: n * 10 + 2 }),
    entry({ role: "assistant", content: [{ type: "text", text: `a${n}` }], stopReason: "stop", timestamp: n * 10 + 3 } as unknown as AgentMessage),
  ];
}
const write = (path: string, entries: SessionEntry[]) => writeFileSync(path, `${[{ type: "session", version: 3, id: "s", cwd: "/repo" }, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
const itemsOf = (entries: SessionEntry[]) => hydrate(createSession("h", "/repo"), entries).items;
const GONE = { content: [{ type: "text", text: "This output is no longer in the chat's session file." }] };
const runsOf = (items: Item[]) => items.flatMap((item) => (item.kind === "assistant" && item.runs ? Object.entries(item.runs) : []));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pigna-payloads-"));
  entryId = 0;
  warn.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("evictPayloads", () => {
  it("keeps the last KEPT_TURNS turns whole and drops the big results, results with images and image data before them", () => {
    const items = itemsOf(Array.from({ length: KEPT_TURNS + 4 }, (_, n) => turn(n)).flat());
    const { items: lean, to } = evictPayloads(items, 0);
    expect(to).toBe(items.findIndex((item) => item.kind === "user" && item.message.timestamp === 40));
    expect(lean.slice(to)).toEqual(items.slice(to));
    lean.slice(to).forEach((item, index) => expect(item).toBe(items[to + index]));
    const runs = Object.fromEntries(runsOf(lean.slice(0, to)));
    // t0 and t2: big; t1: small with an image; t3: small, kept.
    expect(runs.t0).toEqual({ status: "done", startedAt: undefined, endedAt: expect.any(Number), evicted: expect.any(Number) });
    expect(runs.t0!.evicted).toBeGreaterThan(EVICT_BYTES);
    expect(runs.t1).toMatchObject({ evicted: expect.any(Number) });
    expect(runs.t1?.result).toBeUndefined();
    expect(runs.t2?.result).toBeUndefined();
    expect(runs.t3?.result?.content).toEqual([{ type: "text", text: "small 3" }]);
    const prompt = lean[0] as Extract<Item, { kind: "user" }>;
    expect(prompt.evicted).toBe(2_000);
    expect(prompt.message.content).toEqual([{ type: "text", text: "q0" }, { ...png(0), data: "" }]);
    expect(items[0]).not.toBe(prompt);
    // Done once: from `to` on, nothing more until turns move out of the last KEPT_TURNS.
    expect(evictPayloads(lean, to).items).toBe(lean);
    const short = itemsOf(turn(0));
    expect(evictPayloads(short, 0)).toEqual({ items: short, to: 0 });
    expect(evictPayloads(short, 0).items).toBe(short);
  });

  it("leaves what main reads of a chat itself: the push preview, the run's outcome, the answers' text, the prompts' times", () => {
    const items = itemsOf(Array.from({ length: KEPT_TURNS + 4 }, (_, n) => turn(n)).flat());
    const { items: lean } = evictPayloads(items, 0);
    expect(lean).not.toBe(items);
    expect(responsePreview(lean)).toBe(responsePreview(items));
    expect(runOutcome(lean)).toBe(runOutcome(items));
    const texts = (list: Item[]) => list.map((item) => (item.kind === "assistant" ? item.message : item.kind === "user" ? item.message.timestamp : item.kind));
    expect(texts(lean)).toEqual(texts(items));
  });

  it("counts steers as part of their turn", () => {
    const entries = Array.from({ length: KEPT_TURNS + 1 }, (_, n) => turn(n)).flat();
    // A steer delivered after the last turn's tool call.
    entries.splice(-1, 0, entry({ role: "user", content: "steer", timestamp: 999 }));
    const items = itemsOf(entries);
    expect(items.some((item) => item.kind === "user" && item.steer)).toBe(true);
    const { to } = evictPayloads(items, 0);
    expect(to).toBe(items.findIndex((item) => item.kind === "user" && item.message.timestamp === 10));
  });
});

describe("restorePayloads", () => {
  it("reads a result whose line is longer than a read of the file", async () => {
    const path = join(dir, "s.jsonl");
    const entries = [...turn(0, 9 << 20), ...Array.from({ length: KEPT_TURNS }, (_, n) => turn(n + 1)).flat()];
    write(path, entries);
    const items = itemsOf(entries);
    const files = new PayloadFiles();
    files.use(path);
    expect(await restorePayloads(evictPayloads(items, 0).items, files)).toEqual(items);
  });

  it("reads back from the session file what was dropped, and gives the same items back when nothing was", async () => {
    const path = join(dir, "s.jsonl");
    const entries = Array.from({ length: KEPT_TURNS + 4 }, (_, n) => turn(n)).flat();
    write(path, entries);
    const items = itemsOf(entries);
    const { items: lean } = evictPayloads(items, 0);
    const files = new PayloadFiles();
    files.use(path);
    expect(await restorePayloads(lean, files)).toEqual(items);
    expect(await restorePayloads(items, files)).toBe(items);
    expect(warn).not.toHaveBeenCalled();
  });

  it("indexes what pi appends since, and looks in the files pi moved the chat from", async () => {
    const older = join(dir, "older.jsonl");
    const path = join(dir, "s.jsonl");
    const first = Array.from({ length: 4 }, (_, n) => turn(n)).flat();
    write(older, first);
    write(path, []);
    const files = new PayloadFiles();
    files.use(older);
    files.use(path);
    const more: SessionEntry[] = [];
    for (let n = 4; n < KEPT_TURNS + 6; n++) {
      const entries = turn(n);
      more.push(...entries);
      appendFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
      // Read once before the rest is written: the index covers what was there.
      if (n === 5) await restorePayloads(evictPayloads(itemsOf([...first, ...more]), 0).items, files);
    }
    const items = itemsOf([...first, ...more]);
    const { items: lean } = evictPayloads(items, 0);
    const restored = await restorePayloads(lean, files);
    expect(runsOf(restored).map(([id, run]) => [id, run.result?.details])).toEqual(runsOf(items).map(([id]) => [id, { n: Number(id.slice(1)) }]));
    // A line pi is still writing waits for the next read.
    appendFileSync(path, JSON.stringify(entry({ role: "user", content: "partial", timestamp: 1 })).slice(0, 40));
    expect(await restorePayloads(lean, files)).toEqual(restored);
  });

  it("finds what moved in a file rewritten in place, and says what a file no longer has", async () => {
    const path = join(dir, "s.jsonl");
    const entries = Array.from({ length: KEPT_TURNS + 2 }, (_, n) => turn(n)).flat();
    write(path, entries);
    const items = itemsOf(entries);
    const { items: lean } = evictPayloads(items, 0);
    const files = new PayloadFiles();
    files.use(path);
    expect(await restorePayloads(lean, files)).toEqual(items);
    // The same lines in another order, as long as before: the index points into the wrong lines, or at another result.
    write(path, [...entries.slice(4), ...entries.slice(0, 4)]);
    expect(await restorePayloads(lean, files)).toEqual(items);
    write(path, entries);
    expect(await restorePayloads(lean, files)).toEqual(items);
    // t0's line rewritten in place as another result, as long: not t0's anymore.
    const forged = entries.slice();
    const t0 = entries[2] as Extract<SessionEntry, { type: "message" }>;
    forged[2] = { ...t0, message: { ...t0.message, toolCallId: "tX", content: [{ type: "text", text: "z".repeat(EVICT_BYTES) }] } as unknown as AgentMessage };
    write(path, forged);
    expect(runsOf(await restorePayloads(lean, files)).find(([id]) => id === "t0")?.[1].result).toEqual(GONE);
    expect(warn).toHaveBeenCalledTimes(1);
    write(path, entries);
    // Shorter, with a result the index has not seen.
    const other = Array.from({ length: KEPT_TURNS + 1 }, (_, n) => turn(n + 20)).flat();
    write(path, other);
    const otherItems = itemsOf(other);
    expect(await restorePayloads(evictPayloads(otherItems, 0).items, files)).toEqual(otherItems);
    write(path, entries);
    rmSync(path);
    const gone = await restorePayloads(lean, files);
    expect(runsOf(gone).find(([id]) => id === "t0")?.[1].result).toEqual(GONE);
    expect((gone[0] as Extract<Item, { kind: "user" }>).message.content).toEqual([{ type: "text", text: "q0" }, { type: "text", text: "[This image is no longer in the chat's session file.]" }]);
    expect(gone[0]).not.toHaveProperty("evicted");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
