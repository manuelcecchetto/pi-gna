import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atMostEvery, JsonStore, PUBLISH_MS, SAVE_MS, type StoreModel } from "./store";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const real = (await original()) as typeof import("node:fs/promises");
  return { ...real, writeFile: (...args: Parameters<typeof real.writeFile>) => (writes.count++, real.writeFile(...args)) };
});

interface Counter {
  n: number;
  notes: string[];
}
type Op = { type: "add"; note: string } | { type: "same" };
const model = (saveMs?: number): StoreModel<Counter, Op> => ({
  name: "counter",
  item: "note",
  empty: () => ({ n: 0, notes: [] }),
  apply: (value, op) => (op.type === "same" ? value : { n: value.n + 1, notes: [...value.notes, op.note] }),
  parse: (raw) => ({ value: raw as Counter, dropped: 0 }),
  ...(saveMs === undefined ? {} : { saveMs }),
});

/** Every store a test made: each is flushed after the test, so no write of one test lands in the next one's count. */
const stores: JsonStore<Counter, Op>[] = [];

async function setup(saveMs?: number) {
  const file = join(await mkdtemp(join(tmpdir(), "pigna-store-")), "counter.json");
  const pushed: number[] = [];
  const store = new JsonStore(file, model(saveMs), (value) => pushed.push(value.rev));
  stores.push(store);
  await store.get();
  const saved = async () => JSON.parse(await readFile(file, "utf8")) as Counter & { rev: number };
  return { file, store, pushed, saved };
}

/**
 * Lets fs callbacks run while the fake setTimeout holds every save timer: until `done` holds (up to 5 s; a slow disk
 * takes more than a fixed number of turns), or for 50 turns when nothing should happen.
 */
async function settle(done?: () => boolean): Promise<void> {
  const until = Date.now() + 5_000;
  for (let i = 0; done ? !done() && Date.now() < until : i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
  vi.useRealTimers();
  writes.count = 0;
});

describe("JsonStore saves", () => {
  it("saves a burst of changes once, SAVE_MS after the first, as compact JSON", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { file, store, pushed, saved } = await setup();
    for (const note of ["a", "b", "c"]) await store.apply({ type: "add", note });
    expect(pushed).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(SAVE_MS - 1);
    await settle();
    expect(writes.count).toBe(0);
    vi.advanceTimersByTime(1);
    await settle(() => writes.count === 1);
    expect(writes.count).toBe(1);
    await store.flushed();
    expect(writes.count).toBe(1);
    expect(await saved()).toEqual({ n: 3, notes: ["a", "b", "c"], rev: 3 });
    expect(await readFile(file, "utf8")).toBe('{"n":3,"notes":["a","b","c"],"rev":3}');
  });

  it("flushed saves a waiting change at once (quitting right after an op keeps it)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, saved } = await setup();
    await store.apply({ type: "add", note: "last" });
    await store.flushed();
    expect(await saved()).toMatchObject({ n: 1, rev: 1 });
    expect(writes.count).toBe(1);
    vi.advanceTimersByTime(SAVE_MS);
    await settle();
    expect(writes.count).toBe(1);
  });

  it("a change made during a write is saved after its own delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, saved } = await setup();
    await store.apply({ type: "add", note: "a" });
    vi.advanceTimersByTime(SAVE_MS);
    await store.apply({ type: "add", note: "b" });
    await settle();
    expect(writes.count).toBe(1);
    vi.advanceTimersByTime(SAVE_MS);
    await settle(() => writes.count === 2);
    expect(writes.count).toBe(2);
    await store.flushed();
    expect(writes.count).toBe(2);
    expect(await saved()).toMatchObject({ notes: ["a", "b"], rev: 2 });
  });

  it("an op that changes nothing is neither saved nor broadcast", async () => {
    const { store, pushed } = await setup();
    await store.apply({ type: "same" });
    await store.flushed();
    expect(writes.count).toBe(0);
    expect(pushed).toEqual([]);
  });

  it("saveMs 0 saves at once, without waiting for a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, saved } = await setup(0);
    await store.apply({ type: "add", note: "revoked" });
    // No timer was advanced: the write started on its own.
    expect(writes.count).toBe(1);
    await store.flushed();
    expect(await saved()).toMatchObject({ n: 1, rev: 1 });
  });
});

describe("atMostEvery", () => {
  it("sends the first value at once and then only the latest, at most once per interval", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const send = atMostEvery((value: number) => sent.push(value));
    send(1);
    expect(sent).toEqual([1]);
    send(2);
    send(3);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(PUBLISH_MS - 1);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 3]);
    send(4);
    vi.advanceTimersByTime(PUBLISH_MS - 1);
    expect(sent).toEqual([1, 3]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 3, 4]);
    vi.advanceTimersByTime(PUBLISH_MS * 3);
    expect(sent).toEqual([1, 3, 4]);
    send(5);
    expect(sent).toEqual([1, 3, 4, 5]);
  });
});
