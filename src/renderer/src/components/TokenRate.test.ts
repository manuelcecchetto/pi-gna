import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SessionEvent } from "../../../shared/protocol";
import { type AssistantItem, createSession, reduceSessionEvent, type SessionState } from "../../../shared/session-state";
import { TokenRate } from "../components/TokenRate";

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
