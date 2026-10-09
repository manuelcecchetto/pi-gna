import { describe, expect, it } from "vitest";
import type { AssistantMessage, SessionEntry, SessionEvent, ToolCall } from "./protocol";
import type { HostEvent } from "./host-api";
import { type AssistantItem, attention, createSession, hydrate, isDisposable, isDraft, isListed, reduceHostEvent, reduceSessionEvent, runOutcome, type SessionState, strongestAttention } from "./session-state";


const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant",
  content,
  api: "x",
  provider: "p",
  model: "m",
  usage,
  stopReason,
  timestamp: 1,
});
const readCall: ToolCall = { type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/src/a.ts" } };

let clock = 1000;
function play(events: (SessionEvent | HostEvent)[], start: SessionState = createSession("h", "/repo")): SessionState {
  return events.reduce((state, event) => {
    const now = (clock += 100);
    const host: HostEvent = "kind" in event ? event : { kind: "rpc", record: event };
    return reduceHostEvent(state, host, now);
  }, start);
}

const userTurn = (text: string): SessionEvent[] => [
  { type: "message_start", message: { role: "user", content: text, timestamp: 1 } },
  { type: "message_end", message: { role: "user", content: text, timestamp: 1 } },
];

describe("attention (sidebar mark)", () => {
  const chat = (patch: Partial<SessionState>) => ({ ...createSession("h", "/repo"), phase: "ready" as const, ...patch });
  const dialog = { type: "extension_ui_request" as const, id: "d", method: "confirm" as const, title: "?" };

  it("ranks waiting > running > failed > unread, and idle chats get no mark", () => {
    expect(attention(chat({ dialogs: [dialog], running: true, unread: "done" }))).toBe("waiting");
    expect(attention(chat({ running: true, unread: "error" }))).toBe("running");
    expect(attention(chat({ unread: "error" }))).toBe("failed");
    expect(attention(chat({ phase: "exited", unread: "done" }))).toBe("failed");
    expect(attention(chat({ unread: "done" }))).toBe("unread");
    expect(attention(chat({}))).toBe("idle");
  });

  it("rolls a collapsed project up to its strongest chat", () => {
    expect(strongestAttention([chat({}), chat({ unread: "done" }), chat({ unread: "error" })])).toBe("failed");
    expect(strongestAttention([chat({ unread: "done" }), chat({ running: true })])).toBe("running");
    expect(strongestAttention([chat({}), chat({})])).toBeUndefined();
  });

  it("tells a failed run from a finished one when it settles", () => {
    const done = play([{ type: "agent_start" }, ...userTurn("go"), { type: "message_end", message: assistant([{ type: "text", text: "ok" }]) }]);
    expect(runOutcome(done.items)).toBe("done");
    const modelError = play([{ type: "agent_start" }, ...userTurn("go"), { type: "message_end", message: assistant([], "error") }]);
    expect(runOutcome(modelError.items)).toBe("error");
    const retriesFailed = play([{ type: "agent_start" }, ...userTurn("go"), { type: "auto_retry_end", success: false, attempt: 3, finalError: "529" }]);
    expect(runOutcome(retriesFailed.items)).toBe("error");
  });
});

describe("isDraft (kept out of the sidebar)", () => {
  it("is a new chat with nothing sent, running or waiting, and stops being one once you prompt", () => {
    const fresh = createSession("h", "/repo");
    expect(isDraft(fresh)).toBe(true);
    expect(isDraft({ ...fresh, prompted: true })).toBe(false); // sent, before pi echoes the message
    expect(isDraft(play([{ type: "agent_start" }, ...userTurn("hi")], fresh))).toBe(false);
    const dialog = { type: "extension_ui_request" as const, id: "d", method: "confirm" as const, title: "?" };
    expect(isDraft({ ...fresh, dialogs: [dialog] })).toBe(false); // needs you: must stay visible
    expect(isDraft(createSession("h", "/repo", "/s/file.jsonl"))).toBe(false); // opened from disk
    // pi names the session file as soon as it is ready, before anything is written: still a draft.
    const ready = reduceHostEvent(
      fresh,
      { kind: "ready", state: { thinkingLevel: "high", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", sessionFile: "/s/new.jsonl", sessionId: "x", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 } },
      1,
    );
    expect(ready.sessionPath).toBe("/s/new.jsonl");
    expect(isDraft(ready)).toBe(true);
  });

  it("lists sent chats in the chat lists, but not drafts, triage or ATP chats", () => {
    const sent = { ...createSession("h", "/repo"), prompted: true };
    expect(isListed(sent)).toBe(true);
    expect(isListed(createSession("h", "/repo"))).toBe(false);
    expect(isListed({ ...sent, name: "Triage: login bug" })).toBe(false);
    expect(isListed({ ...sent, atp: { role: "worker" } })).toBe(false);
  });
});


describe("dialog_resolved / lease / closed host events", () => {
  const ask = (id: string): HostEvent => ({ kind: "rpc", record: { type: "extension_ui_request", id, method: "confirm", title: "?" } });
  const open = [ask("a"), ask("b")].reduce((state, event) => reduceHostEvent(state, event, 1), createSession("h", "/repo"));

  it("removes a settled dialog by id and keeps the others", () => {
    const next = reduceHostEvent(open, { kind: "dialog_resolved", id: "a", by: "desktop", outcome: "answered" }, 2);
    expect(next.dialogs.map((d) => d.id)).toEqual(["b"]);
  });

  it("ignores an unknown id and leaves the state identical", () => {
    expect(reduceHostEvent(open, { kind: "dialog_resolved", id: "zzz", by: "desktop", outcome: "answered" }, 2)).toBe(open);
  });

  it("lease and closed events do not change the transcript state", () => {
    expect(reduceHostEvent(open, { kind: "lease", clients: [] }, 2)).toBe(open);
    expect(reduceHostEvent(open, { kind: "closed", by: "host" }, 2)).toBe(open);
  });
});

describe("hydrate", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  let id = 0;
  const entry = <T extends Omit<SessionEntry, "id" | "parentId" | "timestamp">>(body: T, second = id) => ({ id: `e${++id}`, parentId: null, timestamp: at(second), ...body }) as unknown as SessionEntry;
  const result = (toolCallId: string, isError = false) => entry({ type: "message", message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: toolCallId }], isError, timestamp: 1 } });
  const call = (callId: string): ToolCall => ({ ...readCall, id: callId });
  const entries: SessionEntry[] = [
    entry({ type: "model_change", provider: "p", modelId: "m" }),
    entry({ type: "thinking_level_change", thinkingLevel: "high" }),
    entry({ type: "session_info", name: "First name" }),
    entry({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }),
    entry({ type: "message", message: assistant([call("c1"), call("c2")], "toolUse") }),
    result("c1"),
    // After a tool-using turn: a steer.
    entry({ type: "message", message: { role: "user", content: "also this", timestamp: 1 } }),
    result("c2", true),
    // A result before its call: no item made it, so it has no run (live or hydrated).
    result("c3"),
    entry({ type: "message", message: assistant([call("c3")], "toolUse") }),
    entry({ type: "compaction", summary: "Earlier", tokensBefore: 1000, firstKeptEntryId: "e4" }),
    entry({ type: "branch_summary", fromId: "e5", summary: "Tried another way" }),
    entry({ type: "custom_message", customType: "note", content: "shown", display: true }),
    entry({ type: "custom_message", customType: "note", content: "hidden", display: false }),
    entry({ type: "message", message: { role: "custom", customType: "ext", content: "from an extension", display: true, timestamp: 1 } }),
    entry({ type: "message", message: { role: "bashExecution", command: "ls", output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } }),
    entry({ type: "message", message: assistant([{ type: "text", text: "done" }]) }),
    entry({ type: "message", message: { role: "user", content: "follow-up", timestamp: 1 } }),
    entry({ type: "custom", customType: "x" } as never),
    entry({ type: "session_info", name: "" }),
  ];

  /** The live reducer, one immutable step per entry: what hydrate must produce. */
  function fold(start: SessionState, list: SessionEntry[]): SessionState {
    return list.reduce((state, item) => {
      const now = Date.parse(item.timestamp);
      const end = (message: Parameters<typeof reduceSessionEvent>[1] & { type: "message_end" }) => reduceSessionEvent(state, message, now);
      switch (item.type) {
        case "message":
          return end({ type: "message_end", message: item.message });
        case "compaction":
          return end({ type: "message_end", message: { role: "compactionSummary", summary: item.summary, tokensBefore: item.tokensBefore, timestamp: now } });
        case "branch_summary":
          return end({ type: "message_end", message: { role: "branchSummary", summary: item.summary, fromId: item.fromId, timestamp: now } });
        case "custom_message":
          return item.display ? reduceSessionEvent(state, { type: "message_end", message: { role: "custom", customType: item.customType, content: item.content, display: true, details: item.details, timestamp: now } }, 0) : state;
        case "session_info":
          return reduceSessionEvent(state, { type: "session_info_changed", name: item.name ?? "" }, now);
        case "thinking_level_change":
          return reduceSessionEvent(state, { type: "thinking_level_changed", level: item.thinkingLevel }, now);
        default:
          return state;
      }
    }, start);
  }
  const shape = (state: SessionState) => ({ items: state.items, seq: state.seq, name: state.name, thinkingLevel: state.thinkingLevel });
  const runs = (state: SessionState) => state.items.flatMap((item) => (item.kind === "assistant" ? Object.entries(item.runs ?? {}).map(([id, run]) => [item.key, id, run.status]) : []));

  it("builds what folding the entries through the live reducer builds", () => {
    const hydrated = hydrate(createSession("h", "/repo"), entries);
    expect(shape(hydrated)).toEqual(shape(fold(createSession("h", "/repo"), entries)));
    expect(hydrated.modelRef).toEqual({ provider: "p", modelId: "m" });
    expect(hydrated.items.filter((item) => item.kind === "user").map((item) => item.kind === "user" && !!item.steer)).toEqual([false, true, false]);
    expect(runs(hydrated)).toEqual([["i2", "c1", "done"], ["i2", "c2", "error"]]);
  });

  it("leaves the state it starts from untouched", () => {
    const start = hydrate(createSession("h", "/repo"), entries.slice(0, 6));
    const items = structuredClone(start.items);
    const again = hydrate(start, entries);
    expect(start.items).toEqual(items);
    expect(again.items).not.toBe(start.items);
    expect(shape(again)).toEqual(shape(hydrate(createSession("h", "/repo"), entries)));
  });
});

describe("tool runs", () => {
  const bashCall: ToolCall = { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } };
  const update = (id: string, text: string): SessionEvent => ({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text }] } });
  const runOf = (state: SessionState, index: number, id: string) => {
    const item = state.items[index];
    return item?.kind === "assistant" ? item.runs?.[id] : undefined;
  };
  // Two tool-using messages, the first's read failed, the second's bash still running, and a steer delivered after it.
  const running = () =>
    play([
      { type: "agent_start" },
      ...userTurn("read it"),
      { type: "message_end", message: assistant([readCall], "toolUse") },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: readCall.arguments },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: true },
      { type: "message_end", message: assistant([bashCall], "toolUse") },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: bashCall.arguments },
      ...userTurn("steer in"),
    ]);

  it("keeps a run on the item that made the call, so an update copies that item alone", () => {
    const before = running();
    expect(before.items.map((item) => item.kind)).toEqual(["user", "assistant", "assistant", "user"]);
    const after = play([update("c2", "a")], before);
    expect(after.items.map((item, index) => item === before.items[index])).toEqual([true, true, false, true]);
    expect(runOf(after, 2, "c2")).toMatchObject({ status: "running", partial: { content: [{ text: "a" }] } });
    expect(runOf(after, 2, "c2")?.startedAt).toBe(runOf(before, 2, "c2")?.startedAt);
    expect(runOf(after, 1, "c1")).toBe(runOf(before, 1, "c1"));
    expect(Object.keys((after.items[2] as AssistantItem).runs ?? {})).toEqual(["c2"]);
  });

  it("keeps the end time of the execution when the result message follows", () => {
    const ended = play([{ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: { content: [] }, isError: true }], running());
    const result = play([{ type: "message_end", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 1 } }], ended);
    expect(runOf(result, 2, "c2")).toMatchObject({ status: "error", endedAt: runOf(ended, 2, "c2")?.endedAt, result: { content: [{ text: "boom" }] } });
  });

  it("ignores an event for a call no message of the turn made", () => {
    const before = running();
    expect(play([update("zz", "a")], before)).toBe(before);
    // A call from an earlier turn is not searched for: pi runs the calls of the message that just ended.
    const next = play([...userTurn("next"), { type: "message_end", message: assistant([{ type: "text", text: "ok" }]) }], play([{ type: "agent_settled" }], before));
    expect(play([update("c1", "late")], next)).toBe(next);
  });

  it("settling fails the runs still running and copies only the items holding them", () => {
    const before = play([update("c2", "a")], running());
    const settled = play([{ type: "agent_settled" }], before);
    // The read that failed before is left as it was.
    expect(settled.items.map((item, index) => item === before.items[index])).toEqual([true, true, false, true]);
    expect(runOf(settled, 1, "c1")?.status).toBe("error");
    expect(runOf(settled, 2, "c2")).toMatchObject({ status: "error", partial: { content: [{ text: "a" }] } });
    expect(runOf(settled, 2, "c2")?.endedAt).toBeUndefined();
  });
});

describe("streaming tool-call arguments", () => {
  const start = (state = play([{ type: "agent_start" }, ...userTurn("write it")])): SessionState =>
    play(
      [
        { type: "message_start", message: assistant([], "pending") },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "w1", toolName: "write" } },
      ],
      state,
    );
  const delta = (state: SessionState, text: string, now: number): SessionState =>
    reduceHostEvent(state, { kind: "rpc", record: { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: text } } }, now);
  const args = (state: SessionState) => {
    const item = state.items[1];
    return item?.kind === "assistant" && item.message.content[0]?.type === "toolCall" ? item.message.content[0].arguments : undefined;
  };

  it("parses small arguments on every delta and large ones at most every 100 ms", () => {
    let state = delta(start(), '{"path": "/repo/a.ts", "content": "', 10_000);
    expect(args(state)).toEqual({ path: "/repo/a.ts", content: "" });
    state = delta(state, "x".repeat(10_000), 10_100);
    expect((args(state)?.content as string).length).toBe(10_000);
    state = delta(state, "y", 10_150); // large and parsed 50 ms ago: keeps the earlier arguments
    expect((args(state)?.content as string).length).toBe(10_000);
    state = delta(state, "z", 10_200);
    expect(args(state)?.content).toBe("x".repeat(10_000) + "yz");
  });

  it("streams a 100 KB write chunk by chunk and ends with the final arguments", () => {
    const final = { path: "/repo/big.ts", content: 'const a = "b\\n";\n'.repeat(6_000) };
    const text = JSON.stringify(final);
    expect(text.length).toBeGreaterThan(100_000);
    let state = start();
    let shown = 0;
    for (let i = 0, now = 0; i < text.length; i += 40, now += 2) {
      state = delta(state, text.slice(i, i + 40), now);
      const content = args(state)?.content;
      if (typeof content === "string") {
        expect(content.length).toBeGreaterThanOrEqual(shown);
        shown = content.length;
      }
    }
    expect(args(state)?.path).toBe("/repo/big.ts");
    expect(shown).toBeGreaterThan(90_000);
    const call: ToolCall = { type: "toolCall", id: "w1", name: "write", arguments: final };
    state = play([{ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call } }], state);
    expect(args(state)).toEqual(final);
    const item = state.items[1];
    expect(item?.kind === "assistant" && item.partialArgs).toEqual({});
  });
});
