import { describe, expect, it } from "vitest";
import { jsonBytes, PAGE_BYTES, PAGE_TURNS, toLatestPage } from "./chat-page";
import { createSession, type Item, type SessionState } from "./session-state";

const user = (n: number, steer = false): Item => ({ kind: "user", key: `i${n}`, message: { role: "user", content: `q${n}`, timestamp: n }, ...(steer && { steer }) });
const answer = (n: number, text = `answer ${n}`): Item => ({ kind: "assistant", key: `a${n}`, streaming: false, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: n } as never });
const chat = (items: Item[], extra: Partial<SessionState> = {}): SessionState => ({ ...createSession("h", "/repo"), items, ...extra });
const turns = (from: number, to: number, text?: (n: number) => string) => Array.from({ length: to - from }, (_, i) => [user(from + i), answer(from + i, text?.(from + i))]).flat();
const keys = (session: SessionState) => session.items.filter((item) => item.kind === "user").map((item) => item.key);

describe("jsonBytes", () => {
  it("is about the JSON length, an image a phone gets as a URL counting as one, and a dropped result as itself", () => {
    const value = { a: "xx", b: [1, null, { c: true }] };
    expect(Math.abs(jsonBytes(value) - JSON.stringify(value).length)).toBeLessThan(40);
    const image = { type: "image", mimeType: "image/png", data: "x".repeat(20_000) };
    expect(jsonBytes(image)).toBeGreaterThan(20_000);
    expect(jsonBytes(image, 16_384)).toBe(128);
    expect(jsonBytes(image, 30_000)).toBeGreaterThan(20_000);
    expect(jsonBytes({ status: "done", evicted: 50_000 })).toBeGreaterThan(50_000);
  });
});

describe("toLatestPage", () => {
  it("keeps a chat that is one page as it is", () => {
    const session = chat(turns(0, PAGE_TURNS));
    expect(toLatestPage(session)).toBe(session);
    const empty = chat([]);
    expect(toLatestPage(empty)).toBe(empty);
  });

  it("drops the turns before the last PAGE_TURNS, a line each after the ones already outlined", () => {
    const session = chat(turns(3, 48), { earlier: [0, 1, 2].map((n) => ({ key: `i${n}`, at: n, label: `q${n}` })) });
    const latest = toLatestPage(session);
    expect(keys(latest)).toEqual(Array.from({ length: PAGE_TURNS }, (_, n) => `i${n + 8}`));
    expect(latest.earlier).toEqual(Array.from({ length: 8 }, (_, n) => ({ key: `i${n}`, at: n, label: `q${n}` })));
    expect(latest.items[0]).toBe(session.items[10]);
  });

  it("keeps fewer turns when they are big, the newest always, and steers stay in their turn", () => {
    const big = (n: number) => (n >= 5 ? "x".repeat(PAGE_BYTES / 3) : "small");
    const session = chat([...turns(0, 8, big).slice(0, -1), user(80, true), answer(7, big(7))]);
    // Turns 7 and 6 fit (with turn 7's steer); turn 5 would make three big ones.
    expect(keys(toLatestPage(session))).toEqual(["i6", "i7", "i80"]);
    const huge = chat(turns(0, 3, (n) => (n === 2 ? "x".repeat(PAGE_BYTES * 2) : "small")));
    expect(keys(toLatestPage(huge))).toEqual(["i2"]);
  });

  it("drops the rest of a turn that came in part, which then pages in whole", () => {
    const session = chat([answer(4), answer(5), ...turns(5, 50)], { earlier: [0, 1, 2, 3, 4].map((n) => ({ key: `i${n}`, at: n, label: `q${n}` })), earlierOffset: 2 });
    const latest = toLatestPage(session);
    expect(latest.items[0]).toBe(session.items[12]);
    expect(latest.earlier?.map((turn) => turn.key)).toEqual(Array.from({ length: 10 }, (_, n) => `i${n}`));
    expect(latest.earlierOffset).toBeUndefined();
  });

  it("counts results main dropped as what a page brings back", () => {
    const run = (n: number): Item => ({ ...answer(n), runs: { [`t${n}`]: { status: "done", evicted: PAGE_BYTES / 3 } } } as Item);
    const session = chat(Array.from({ length: 6 }, (_, n) => [user(n), run(n)]).flat());
    expect(keys(toLatestPage(session))).toEqual(["i4", "i5"]);
  });
});
