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

// 400 characters: about 100 tokens.
const streamed: [number, SessionEvent][] = [
  [0, { type: "agent_start" }],
  [100, { type: "message_start", message: assistant([]) }],
  [1000, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
  [1500, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) } }],
];

describe("token rate", () => {
  it("estimates from the streamed text, timed from the first block, while the response streams", () => {
    const rate = responseRate(lastAssistant(play(streamed)), 3000);
    expect(rate).toEqual({ perSecond: 50, tokens: 100, seconds: 2, estimated: true, live: true });
  });

  it("switches to the provider's output count once the response ends", () => {
    const state = play([
      ...streamed,
      [3000, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(400) } }],
      [3000, { type: "message_end", message: assistant([{ type: "text", text: "x".repeat(400) }], 180) }],
      [3100, { type: "agent_settled" }],
    ]);
    // Later clocks do not change a finished response.
    expect(responseRate(lastAssistant(state), 60_000)).toEqual({ perSecond: 90, tokens: 180, seconds: 2, estimated: false, live: false });
  });

  it("counts thinking and streamed tool arguments, but not redacted thinking", () => {
    const state = play([
      [0, { type: "message_start", message: assistant([]) }],
      [0, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }],
      [0, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t".repeat(200) } }],
      [500, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" } }],
      [600, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path": "/repo/sr' } }],
    ]);
    expect(responseRate(lastAssistant(state), 1000)?.tokens).toBe(Math.round((200 + 18) / 4));
    const item = lastAssistant(state);
    const redacted = { ...item, message: { ...item.message, content: [{ type: "thinking" as const, thinking: "opaque", redacted: true }] } };
    expect(responseRate(redacted, 1000)).toBeUndefined();
  });

  it("waits for half a second of streaming, keeping the previous response meanwhile", () => {
    const first = play([
      ...streamed,
      [3000, { type: "message_end", message: assistant([{ type: "text", text: "x".repeat(400) }], 180) }],
    ]);
    const next = play([
      [4000, { type: "message_start", message: assistant([]) }],
      [4100, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }],
      [4200, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(40) } }],
    ], first);
    expect(responseRate(lastAssistant(next), 4300)).toBeUndefined();
    expect(latestRate(next.items, 4300)).toMatchObject({ perSecond: 90, live: false });
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
    const live = render(play(streamed), 3000);
    expect(live).toContain("~50 tok/s");
    expect(live).toContain("text-muted");
    expect(live).toContain("Output speed of the response streaming now: ~100 tokens in 2.0s");
    const done = render(play([...streamed, [3000, { type: "message_end", message: assistant([{ type: "text", text: "x".repeat(400) }], 15) }], [3100, { type: "agent_settled" }]]), 60_000);
    expect(done).toContain("7.5 tok/s");
    expect(done).not.toContain("~");
    expect(done).toContain("text-faint");
  });

  it("renders nothing before a response has a rate", () => {
    expect(render(play(streamed.slice(0, 2)), 3000)).toBe("");
  });
});
