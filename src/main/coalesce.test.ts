import { describe, expect, it } from "vitest";
import type { HostEvent } from "../shared/host-api";
import { createSession, reduceHostEvent, type SessionState } from "../shared/session-state";
import { coalesce, isDelta } from "./coalesce";

const usage = (output: number) => ({ input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const rpc = (record: object): HostEvent => ({ kind: "rpc", record }) as HostEvent;
const update = (assistantMessageEvent: object, extra: object = {}) => rpc({ type: "message_update", assistantMessageEvent, ...extra });
const delta = (type: "text_delta" | "thinking_delta" | "toolcall_delta", contentIndex: number, text: string, extra: object = {}) => update({ type, contentIndex, delta: text }, extra);

describe("coalesce", () => {
  it("merges consecutive deltas of one block, keeping the later event's usage", () => {
    const merged = coalesce([delta("text_delta", 0, "Hel", { usage: usage(1) }), delta("text_delta", 0, "lo", { usage: usage(2) }), delta("text_delta", 0, "!")]);
    expect(merged).toEqual([delta("text_delta", 0, "Hello!", { usage: usage(2) })]);
  });

  it("keeps deltas of other blocks or kinds, and anything between them, apart and in order", () => {
    const end = update({ type: "text_end", contentIndex: 0, content: "ab" });
    const events = [
      delta("text_delta", 0, "a"),
      delta("text_delta", 1, "b"),
      delta("text_delta", 1, "c"),
      delta("thinking_delta", 1, "t"),
      end,
      delta("thinking_delta", 1, "u"),
      rpc({ type: "agent_end", messages: [] }),
    ];
    const before = structuredClone(events);
    expect(coalesce(events)).toEqual([delta("text_delta", 0, "a"), delta("text_delta", 1, "bc"), delta("thinking_delta", 1, "t"), end, delta("thinking_delta", 1, "u"), rpc({ type: "agent_end", messages: [] })]);
    expect(events).toEqual(before);
  });

  it("only lets text, thinking and tool-call deltas wait", () => {
    expect([delta("text_delta", 0, "x"), delta("thinking_delta", 0, "x"), delta("toolcall_delta", 0, "x")].every(isDelta)).toBe(true);
    expect(isDelta(update({ type: "text_start", contentIndex: 0 }))).toBe(false);
    expect(isDelta(rpc({ type: "tool_execution_update", toolCallId: "c", partialResult: {} }))).toBe(false);
    expect(isDelta({ kind: "ready", state: {} } as HostEvent)).toBe(false);
  });

  it("reduces to the same state as the deltas one by one, mid-stream and at the end", () => {
    const args = JSON.stringify({ path: "src/a.ts", content: "line one\nline \"two\"\n".repeat(20) });
    const chunks = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
    const call = { type: "toolCall", id: "c1", name: "write", arguments: JSON.parse(args) };
    const message = { role: "assistant", content: [], api: "a", provider: "p", model: "m", usage: usage(0), stopReason: "toolUse", timestamp: 1 };
    const streaming: HostEvent[] = [
      rpc({ type: "agent_start" }),
      rpc({ type: "message_start", message }),
      update({ type: "thinking_start", contentIndex: 0 }),
      ...chunks("Let me think about the file first.", 4).map((text, i) => delta("thinking_delta", 0, text, { usage: usage(i) })),
      update({ type: "thinking_end", contentIndex: 0, content: "Let me think about the file first." }),
      update({ type: "text_start", contentIndex: 1 }),
      ...chunks("Writing **the file** now:\n\n- one\n- two", 3).map((text) => delta("text_delta", 1, text)),
      update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "write" }),
      ...chunks(args, 7).map((text) => delta("toolcall_delta", 2, text)),
    ];
    const ends: HostEvent[] = [
      update({ type: "text_end", contentIndex: 1, content: "Writing **the file** now:\n\n- one\n- two" }),
      update({ type: "toolcall_end", contentIndex: 2, toolCall: call }),
      rpc({ type: "message_end", message: { ...message, content: [{ type: "thinking", thinking: "Let me think about the file first." }, { type: "text", text: "Writing **the file** now:\n\n- one\n- two" }, call] } }),
    ];
    const reduce = (events: HostEvent[]) => events.reduce((state: SessionState, event) => reduceHostEvent(state, event, 1000), createSession("h", "/tmp"));
    expect(coalesce(streaming).length).toBeLessThan(streaming.length / 4);
    expect(reduce(coalesce(streaming))).toEqual(reduce(streaming));
    expect(reduce(coalesce([...streaming, ...ends]))).toEqual(reduce([...streaming, ...ends]));
  });
});
