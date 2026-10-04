import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SessionEntry, SessionEvent } from "../../../shared/protocol";
import { type AssistantItem, createSession, hydrate, reduceSessionEvent, type SessionState } from "./session";
import { TokenRate } from "../components/TokenRate";
import { latestRate, responseRate } from "./token-rate";

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

// 400 characters (about 100 tokens) in one second, a delta every quarter second.
const streamed: [number, SessionEvent][] = [
  [0, { type: "agent_start" }],
  [100, { type: "message_start", message: assistant([]) }],
  [1000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
  text(1250, 100), text(1500, 100), text(1750, 100), text(2000, 100),
];
const ended = (at: number, output: number, reasoning?: number, more: AssistantMessage["content"] = []): [number, SessionEvent][] => [
  [at, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(400) } }],
  [at, { type: "message_end", message: { ...assistant([{ type: "text", text: "x".repeat(400) }, ...more], output), usage: { ...usage(output), reasoning } } }],
];

describe("token rate", () => {
  it("estimates from the streamed text, timed from the first block, while the response streams", () => {
    const rate = responseRate(lastAssistant(play(streamed)), 2000);
    expect(rate).toEqual({ perSecond: 100, tokens: 100, seconds: 1, estimated: true, live: true });
  });

  it("stops the clock when nothing streams, so waits do not lower the rate", () => {
    const item = lastAssistant(play(streamed));
    // Up to a second of a pause counts, then the rate holds.
    expect(responseRate(item, 2500)?.seconds).toBe(1.5);
    expect(responseRate(item, 3000)?.seconds).toBe(2);
    expect(responseRate(item, 60_000)).toMatchObject({ perSecond: 50, seconds: 2 });
  });

  it("does not count waits between stream events", () => {
    const state = play([...streamed, text(20_000, 400), text(20_100, 400), text(50_000, 400)]);
    // 1s of text, 1s of the 18s pause, 0.1s, 1s of the 30s pause; 1600 characters.
    expect(responseRate(lastAssistant(state), 50_000)).toMatchObject({ tokens: 400, seconds: 3.1, live: true });
  });

  it("leaves out tool calls, whose arguments often arrive in one burst", () => {
    const call = { type: "toolCall" as const, id: "c1", name: "write", arguments: { content: "y".repeat(4000) } };
    const burst: [number, SessionEvent][] = [
      ...streamed,
      [2000, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(400) } }],
      [5000, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "write" } }],
      [5010, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(call.arguments) } }],
      [5020, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: call } }],
    ];
    // Neither the burst's 1000 tokens nor its time count: the text's 100 tokens in 1s.
    expect(responseRate(lastAssistant(play(burst)), 5020)).toMatchObject({ perSecond: 100, tokens: 100, seconds: 1, live: true });
    // The provider's count includes the arguments, so the estimate stays once the response ends.
    const done = play([[5030, { type: "message_end", message: assistant([{ type: "text", text: "x".repeat(400) }, call], 1300) }]], play(burst));
    expect(responseRate(lastAssistant(done), 60_000)).toEqual({ perSecond: 100, tokens: 100, seconds: 1, estimated: true, live: false });
    // A response that only calls tools has no rate.
    const only = play([
      [0, { type: "message_start", message: assistant([]) }],
      [0, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" } }],
      [2000, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "y".repeat(4000) } }],
    ]);
    expect(responseRate(lastAssistant(only), 2000)).toBeUndefined();
  });

  it("switches to the provider's output count once the response ends", () => {
    const state = play([...streamed, ...ended(2000, 180), [3100, { type: "agent_settled" }]]);
    // Later clocks do not change a finished response.
    expect(responseRate(lastAssistant(state), 60_000)).toEqual({ perSecond: 180, tokens: 180, seconds: 1, estimated: false, live: false });
  });

  it("leaves out reasoning the provider did not stream", () => {
    const thought: [number, SessionEvent][] = [
      [0, { type: "message_start", message: assistant([]) }],
      [0, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } }],
      [500, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "t".repeat(200) } }],
      [500, { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "t".repeat(200) } }],
      [10_000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
      [10_500, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } }],
    ];
    // 2000 reasoning tokens over the 10s pause, 50 of them streamed as a summary; 100 text tokens.
    const summary: AssistantMessage["content"] = [{ type: "thinking", thinking: "t".repeat(200) }];
    const hidden = play([...thought, ...ended(10_500, 2100, 2000, summary)]);
    expect(responseRate(lastAssistant(hidden), 20_000)).toMatchObject({ tokens: 150, seconds: 2, estimated: true });
    // Providers without a reasoning breakdown: their count as reported.
    const plain = play([...thought, ...ended(10_500, 2100, undefined, summary)]);
    expect(responseRate(lastAssistant(plain), 20_000)).toMatchObject({ tokens: 2100, estimated: false });
  });

  it("counts thinking, but not tool arguments or redacted thinking", () => {
    const state = play([
      [0, { type: "message_start", message: assistant([]) }],
      [0, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }],
      [0, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t".repeat(100) } }],
      [500, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t".repeat(100) } }],
      [500, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" } }],
      [600, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path": "/repo/sr' } }],
    ]);
    expect(responseRate(lastAssistant(state), 1000)).toMatchObject({ tokens: 50, seconds: 0.5 });
    const item = lastAssistant(state);
    const redacted = { ...item, message: { ...item.message, content: [{ type: "thinking" as const, thinking: "opaque", redacted: true }] } };
    expect(responseRate(redacted, 1000)).toBeUndefined();
  });

  it("waits for half a second of streaming, keeping the previous response meanwhile", () => {
    const first = play([...streamed, ...ended(2000, 180)]);
    const next = play([
      [4000, { type: "message_start", message: assistant([]) }],
      [4100, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
      [4200, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(40) } }],
    ], first);
    expect(responseRate(lastAssistant(next), 4300)).toBeUndefined();
    expect(latestRate(next.items, 4300)).toMatchObject({ perSecond: 180, live: false });
    expect(latestRate(next.items, 5100)).toMatchObject({ perSecond: 10, tokens: 10, live: true });
  });

  it("has no rate for responses read from a session file or cut off mid-stream", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "a", parentId: null, timestamp: "2026-10-03T10:00:00Z", message: assistant([{ type: "text", text: "x".repeat(400) }], 100) },
    ];
    expect(latestRate(hydrate(createSession("h", "/repo"), entries).items, 10_000)).toBeUndefined();
    const crashed = play([[5000, { type: "agent_settled" }]], play(streamed));
    expect(latestRate(crashed.items, 10_000)).toBeUndefined();
  });
});

describe("TokenRate", () => {
  afterEach(() => vi.useRealTimers());
  const render = (session: SessionState, now: number) => {
    vi.useFakeTimers({ now });
    return renderToStaticMarkup(createElement(TokenRate, { session }));
  };

  it("shows the live estimate, then the reported rate dimmed once the response ends", () => {
    const live = render(play(streamed), 2000);
    expect(live).toContain("~100 tok/s");
    expect(live).toContain("text-muted");
    expect(live).toContain("Output speed of the response streaming now: ~100 tokens in 1.0s");
    const done = render(play([...streamed, ...ended(2000, 15), [3100, { type: "agent_settled" }]]), 60_000);
    expect(done).toContain("15 tok/s");
    expect(done).not.toContain("~");
    expect(done).toContain("text-faint");
  });

  it("renders nothing before a response has a rate", () => {
    expect(render(play(streamed.slice(0, 2)), 3000)).toBe("");
  });
});
