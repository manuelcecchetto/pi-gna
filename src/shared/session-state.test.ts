import { describe, expect, it } from "vitest";
import type { AssistantMessage, SessionEntry, SessionEvent, ToolCall } from "./protocol";
import type { HostEvent } from "./host-api";
import { attention, createSession, hydrate, isDisposable, isDraft, isListed, reduceHostEvent, runOutcome, type SessionState, strongestAttention } from "./session-state";


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
