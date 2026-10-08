import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SessionEvent } from "../../../shared/protocol";
import { createSession, reduceSessionEvent, type SessionState } from "../../../shared/session-state";
import { shallow } from "../lib/store";
import { composerFields } from "./Composer";

vi.mock("../state/app", () => ({}));

const usage = { input: 900, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant: AssistantMessage = { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 1 };
const update = (assistantMessageEvent: unknown): SessionEvent => ({ type: "message_update", assistantMessageEvent } as SessionEvent);
const play = (events: SessionEvent[], start: SessionState) => events.reduce((state, event, index) => reduceSessionEvent(state, event, 1000 + index), start);

describe("composerFields", () => {
  // The composer renders only when its slice changes (useAppShallow): a streaming chat must leave it alone.
  it("keeps the composer's slice through streaming deltas and tool output", () => {
    let state = play([{ type: "agent_start" }, { type: "message_start", message: assistant }, update({ type: "text_start", contentIndex: 0 })], createSession("h", "/repo"));
    const fields = composerFields(state);
    expect(fields?.cacheHit).toBeCloseTo(0.1);
    const stream: SessionEvent[] = [
      update({ type: "text_delta", contentIndex: 0, delta: "Hello" }),
      update({ type: "text_delta", contentIndex: 0, delta: " world" }),
      update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" }),
      update({ type: "toolcall_delta", contentIndex: 1, delta: '{"command": "ls' }),
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: { command: "ls" }, partialResult: { content: [{ type: "text", text: "a.ts" }] } },
    ] as SessionEvent[];
    for (const event of stream) {
      const next = reduceSessionEvent(state, event, 2000);
      expect(next, event.type).not.toBe(state);
      expect(shallow(composerFields(next), fields), event.type).toBe(true);
      state = next;
    }
  });

  it("changes when what the composer shows changes", () => {
    const state = play([{ type: "agent_start" }], createSession("h", "/repo"));
    const fields = composerFields(state);
    expect(shallow(composerFields(play([{ type: "queue_update", steering: ["later"], followUp: [] } as SessionEvent], state)), fields)).toBe(false);
    expect(shallow(composerFields(play([{ type: "agent_settled" }], state)), fields)).toBe(false);
    expect(composerFields(undefined)).toBeUndefined();
  });
});
