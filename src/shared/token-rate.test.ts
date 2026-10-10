import { describe, expect, it } from "vitest";
import type { AssistantMessage, SessionEntry, SessionEvent } from "./protocol";
import { type AssistantItem, createSession, hydrate, reduceSessionEvent, type SessionState } from "./session-state";
import { latestRate, rateHistory, rateMoving, responseRate } from "./token-rate";

const usage = (output: number) => ({ input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (content: AssistantMessage["content"], output = 0): AssistantMessage => ({
  role: "assistant", content, api: "x", provider: "p", model: "m", usage: usage(output), stopReason: "stop", timestamp: 1,
});

/** Events at the given times (ms). */
function play(events: [number, SessionEvent][], start: SessionState = createSession("h", "/repo")): SessionState {
  return events.reduce((state, [at, event]) => reduceSessionEvent(state, event, at), start);
}
const lastAssistant = (state: SessionState) => state.items.findLast((item): item is AssistantItem => item.kind === "assistant")!;

const text = (at: number, chars: number): [number, SessionEvent] =>
  [at, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(chars) } }];

// 400 characters (about 100 tokens) in the response's first second, a delta every quarter second.
const streamed: [number, SessionEvent][] = [
  [0, { type: "agent_start" }],
  [1000, { type: "message_start", message: assistant([]) }],
  [1000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
  text(1250, 100), text(1500, 100), text(1750, 100), text(2000, 100),
];
const ended = (at: number, output: number, more: AssistantMessage["content"] = []): [number, SessionEvent][] => [
  [at, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(400) } }],
  [at, { type: "message_end", message: assistant([{ type: "text", text: "x".repeat(400) }, ...more], output) }],
];

describe("token rate", () => {
  it("moves with time alone while the newest response streams", () => {
    const state = play(streamed);
    expect(rateMoving(state.items)).toBe(true);
    expect(rateMoving(play(ended(2000, 15), state).items)).toBe(false);
    expect(rateMoving(play([[2100, { type: "message_start", message: assistant([]) }]], play(ended(2000, 15), state)).items)).toBe(true);
    expect(rateMoving(createSession("h", "/repo").items)).toBe(false);
  });

  it("estimates from the streamed output over the time since the response started", () => {
    expect(responseRate(lastAssistant(play(streamed)), 2000)).toEqual({ perSecond: 100, tokens: 100, seconds: 1, estimated: true, live: true });
  });

  it("counts time to first token and pauses inside the response", () => {
    const late = play([
      [0, { type: "message_start", message: assistant([]) }],
      [3000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
      text(4000, 400),
    ]);
    expect(responseRate(lastAssistant(late), 4000)).toMatchObject({ tokens: 100, seconds: 4, perSecond: 25 });
    // Nothing streams for 3s more: the rate keeps falling while the response is open.
    expect(responseRate(lastAssistant(late), 7000)).toMatchObject({ tokens: 100, seconds: 7 });
  });

  it("switches to the provider's output count over the whole response once it ends", () => {
    const state = play([...streamed, ...ended(3000, 180), [3100, { type: "agent_settled" }]]);
    // Later clocks do not change a finished response.
    expect(responseRate(lastAssistant(state), 60_000)).toEqual({ perSecond: 90, tokens: 180, seconds: 2, estimated: false, live: false });
  });

  it("counts tool-call arguments, streamed or finished", () => {
    const call = { type: "toolCall" as const, id: "c1", name: "write", arguments: { content: "y".repeat(3986) } };
    const args = JSON.stringify(call.arguments); // 4000 characters
    const calling: [number, SessionEvent][] = [
      [0, { type: "message_start", message: assistant([]) }],
      [0, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" } }],
      [1000, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: args.slice(0, 2000) } }],
    ];
    expect(responseRate(lastAssistant(play(calling)), 1000)).toMatchObject({ tokens: 500, seconds: 1, estimated: true });
    const finished = play([[2000, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call } }]], play(calling));
    expect(responseRate(lastAssistant(finished), 2000)).toMatchObject({ tokens: 1000, seconds: 2, estimated: true });
    const done = play([[2000, { type: "message_end", message: assistant([call], 1100) }]], finished);
    expect(responseRate(lastAssistant(done), 60_000)).toEqual({ perSecond: 550, tokens: 1100, seconds: 2, estimated: false, live: false });
  });

  it("counts thinking, but not redacted thinking", () => {
    const state = play([
      [0, { type: "message_start", message: assistant([]) }],
      [0, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }],
      [1000, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t".repeat(200) } }],
    ]);
    expect(responseRate(lastAssistant(state), 1000)).toMatchObject({ tokens: 50, seconds: 1 });
    const item = lastAssistant(state);
    const redacted = { ...item, message: { ...item.message, content: [{ type: "thinking" as const, thinking: "opaque", redacted: true }] } };
    expect(responseRate(redacted, 1000)).toBeUndefined();
  });

  it("keeps the estimate when the provider reports no output count", () => {
    const state = play([...streamed, ...ended(2000, 0)]);
    expect(responseRate(lastAssistant(state), 60_000)).toEqual({ perSecond: 100, tokens: 100, seconds: 1, estimated: true, live: false });
  });

  it("waits for half a second of a response, keeping the previous one meanwhile", () => {
    const first = play([...streamed, ...ended(2000, 180)]);
    const next = play([
      [4000, { type: "message_start", message: assistant([]) }],
      [4000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
      [4200, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(40) } }],
    ], first);
    expect(responseRate(lastAssistant(next), 4300)).toBeUndefined();
    expect(latestRate(next.items, 4300)).toMatchObject({ perSecond: 180, live: false });
    expect(latestRate(next.items, 5000)).toMatchObject({ perSecond: 10, tokens: 10, live: true });
  });

  it("charts every measured response oldest first, the streaming one at now", () => {
    const first = play([...streamed, ...ended(2000, 180)]);
    const next = play([
      [4000, { type: "message_start", message: assistant([]) }],
      [4000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
      [4200, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(40) } }],
    ], first);
    expect(rateHistory(next.items, 5000)).toMatchObject([
      { at: 2000, perSecond: 180, live: false },
      { at: 5000, perSecond: 10, live: true },
    ]);
    // Too short yet: only the finished one.
    expect(rateHistory(next.items, 4300)).toHaveLength(1);
  });

  it("times responses read from a session file from the request to the entry", () => {
    const sent = Date.parse("2026-10-03T10:00:00Z");
    const entry = (id: string, at: number, written: string, output: number): SessionEntry => ({
      type: "message", id, parentId: null, timestamp: written, message: { ...assistant([{ type: "text", text: "x".repeat(400) }], output), timestamp: at },
    });
    const state = hydrate(createSession("h", "/repo"), [
      entry("a", sent, "2026-10-03T10:00:04Z", 200),
      entry("b", sent + 10_000, "2026-10-03T10:00:10.200Z", 5), // under half a second: no rate
    ]);
    expect(latestRate(state.items, 0)).toMatchObject({ perSecond: 50, tokens: 200, seconds: 4, estimated: false, live: false });
    expect(rateHistory(state.items, 0)).toMatchObject([{ at: sent + 4000, perSecond: 50 }]);
    // Then a live response joins the chart after them.
    const live = play([...streamed.map(([at, event]): [number, SessionEvent] => [sent + 20_000 + at, event]), ...ended(sent + 22_000, 180)], state);
    expect(rateHistory(live.items, 0).map((point) => point.perSecond)).toEqual([50, 180]);
  });

  it("has no rate for a response cut off mid-stream", () => {
    const crashed = play([[5000, { type: "agent_settled" }]], play(streamed));
    expect(latestRate(crashed.items, 10_000)).toBeUndefined();
  });
});
