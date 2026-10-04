import { describe, expect, it } from "vitest";
import type { HostEvent } from "../../../shared/ipc";
import type { AssistantMessage, SessionEntry, SessionEvent, ToolCall } from "../../../shared/protocol";
import { attention, createSession, hydrate, isDisposable, isDraft, reduceHostEvent, runOutcome, type SessionState, strongestAttention } from "./session";
import { liveComputerApp, presentTool, summarizeTools, toolTimeoutMs } from "./tools";
import { createRunDeriver, deriveRuns, layoutRun, needsTimeDivider, type Run } from "./view";

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

describe("session reducer", () => {
  it("reconstructs streamed text and replaces it with authoritative content", () => {
    const state = play([
      { type: "agent_start" },
      ...userTurn("hi"),
      { type: "message_start", message: assistant([], "pending") },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
    ]);
    expect(state.running).toBe(true);
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    const streaming = state.items[1];
    expect(streaming?.kind === "assistant" && streaming.streaming && streaming.message.content[0]).toEqual({ type: "text", text: "Hello" });

    const ended = play([{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello!" } }, { type: "message_end", message: assistant([{ type: "text", text: "Hello, world" }]) }, { type: "agent_settled" }], state);
    const final = ended.items[1];
    expect(final?.kind === "assistant" && final.message.content).toEqual([{ type: "text", text: "Hello, world" }]);
    expect(final?.kind === "assistant" && final.streaming).toBe(false);
    expect(ended.running).toBe(false);
  });

  it("streams tool-call arguments and tracks the tool execution lifecycle", () => {
    const state = play([
      { type: "agent_start" },
      ...userTurn("read it"),
      { type: "message_start", message: assistant([], "pending") },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "read" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path": "/repo/sr' } },
    ]);
    const live = state.items[1];
    expect(live?.kind === "assistant" && live.message.content[0]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "/repo/sr" } });
    expect(deriveRuns(state)[0]?.blocks[0]).toMatchObject({ kind: "activity", live: true, steps: [{ kind: "tool", argsStreaming: true }] });

    const done = play(
      [
        { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: readCall } },
        { type: "message_end", message: assistant([readCall], "toolUse") },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: readCall.arguments },
        { type: "tool_execution_update", toolCallId: "c1", toolName: "read", args: readCall.arguments, partialResult: { content: [{ type: "text", text: "par" }] } },
      ],
      state,
    );
    expect(done.tools.c1).toMatchObject({ status: "running", partial: { content: [{ text: "par" }] } });

    const finished = play(
      [
        { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "body" }] }, isError: false },
        { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 2 } },
      ],
      done,
    );
    expect(finished.tools.c1).toMatchObject({ status: "done", result: { content: [{ text: "body" }] } });
    expect(finished.tools.c1?.endedAt).toBeGreaterThan(finished.tools.c1?.startedAt ?? Infinity);
    expect(finished.items).toHaveLength(2); // tool results attach to calls, not to the transcript
  });

  it("settling after an abort clears streaming flags and running tools", () => {
    const state = play([
      { type: "agent_start" },
      { type: "message_start", message: assistant([], "pending") },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "tool_execution_start", toolCallId: "c9", toolName: "bash", args: {} },
      { type: "agent_settled" },
    ]);
    const item = state.items[0];
    expect(item?.kind === "assistant" && item.streaming).toBe(false);
    expect(state.tools.c9?.status).toBe("error");
    expect(state.running).toBe(false);
  });

  it("tracks dialogs, statuses, widgets and editor text from extension UI requests", () => {
    const state = play([
      { kind: "rpc", record: { type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?" } },
      { kind: "rpc", record: { type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "git", statusText: "main" } },
      { kind: "rpc", record: { type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "tmp", statusText: "x" } },
      { kind: "rpc", record: { type: "extension_ui_request", id: "s3", method: "setStatus", statusKey: "tmp" } },
      { kind: "rpc", record: { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "todo", widgetLines: ["a"] } },
      { kind: "rpc", record: { type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "draft" } },
    ]);
    expect(state.dialogs.map((dialog) => dialog.id)).toEqual(["d1"]);
    expect(state.statuses).toEqual({ git: "main" });
    expect(state.widgets.todo).toEqual({ lines: ["a"], placement: "aboveEditor" });
    expect(state.editorText?.text).toBe("draft");
  });

  it("marks the session exited and drops dialogs when pi dies", () => {
    const state = play([
      { kind: "rpc", record: { type: "extension_ui_request", id: "d1", method: "input", title: "Name" } },
      { kind: "exit", code: 1, signal: null, stderrTail: "boom" },
    ]);
    expect(state.phase).toBe("exited");
    expect(state.dialogs).toEqual([]);
    expect(state.exit?.stderrTail).toBe("boom");
  });
});

describe("hydrate + view", () => {
  const entry = (id: string, message: unknown): SessionEntry => ({ type: "message", id, parentId: null, timestamp: "2026-10-01T10:00:00.000Z", message }) as SessionEntry;
  const entries: SessionEntry[] = [
    { type: "session_info", id: "n", parentId: null, timestamp: "", name: "Auth fix" },
    entry("u1", { role: "user", content: "fix auth", timestamp: 1 }),
    entry("a1", assistant([{ type: "thinking", thinking: "look first" }, readCall, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "pnpm test\n--watch" } }], "toolUse")),
    entry("t1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "src" }], isError: false, timestamp: 2 }),
    entry("t2", { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "fail" }], isError: true, timestamp: 3 }),
    entry("a2", assistant([{ type: "text", text: "Found it." }, { type: "toolCall", id: "c3", name: "edit", arguments: { path: "/repo/src/a.ts" } }], "toolUse")),
    entry("a3", assistant([{ type: "text", text: "" }], "aborted")),
    { type: "compaction", id: "k", parentId: null, timestamp: "", summary: "sum", firstKeptEntryId: "u1", tokensBefore: 9 },
    entry("u2", { role: "user", content: [{ type: "text", text: "again" }], timestamp: 4 }),
  ];

  it("hydrates entries into runs with merged activity groups", () => {
    const state = hydrate(createSession("h", "/repo"), entries);
    expect(state.name).toBe("Auth fix");
    expect(state.tools.c2?.status).toBe("error");
    const runs = deriveRuns(state);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.blocks.map((block) => block.kind)).toEqual(["activity", "text", "activity", "aborted", "compaction"]);
    const group = runs[0]?.blocks[0];
    expect(group?.kind === "activity" && group.steps.map((step) => step.kind)).toEqual(["thinking", "tool", "tool"]);
    // Groups and steps toggle independently, so their expand keys must never collide.
    const keys = runs.flatMap((run) => run.blocks.flatMap((block) => (block.kind === "activity" ? [block.key, ...block.steps.map((step) => step.key)] : [])));
    expect(new Set(keys).size).toBe(keys.length);
    // c3 never got a result: an interrupted call, not a running one.
    const second = runs[0]?.blocks[2];
    expect(second?.kind === "activity" && second.steps[0]?.kind === "tool" && second.steps[0].run).toBeUndefined();
  });

  it("reuses finished runs while the live run changes", () => {
    const derive = createRunDeriver();
    const state = { ...hydrate(createSession("h", "/repo"), entries), running: true };
    const first = derive(state);
    const next = play([{ type: "message_start", message: assistant([], "pending") }, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }], state);
    const second = derive(next);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it("summarizes tools by category with unique files and failures", () => {
    const summary = summarizeTools([
      { presentation: presentTool("read", { path: "/repo/a.ts" }, "/repo"), failed: false },
      { presentation: presentTool("read", { path: "/repo/a.ts", offset: 10, limit: 5 }, "/repo"), failed: false },
      { presentation: presentTool("bash", { command: "ls" }, "/repo"), failed: true },
      { presentation: presentTool("edit", { path: "/repo/b.ts" }, "/repo", { diff: "+1 a\n-1 b\n+2 c" }), failed: false },
    ]);
    expect(summary).toBe("Read 1 file · ran 1 command · edited 1 file · 1 failed");
    expect(presentTool("read", { path: "/repo/a.ts", offset: 10, limit: 5 }, "/repo")).toMatchObject({ target: "a.ts", meta: "L10–14" });
    expect(presentTool("edit", { path: "/repo/b.ts" }, "/repo", { diff: "+1 a\n-1 b\n+2 c" }).meta).toBe("+2 −1");
    expect(presentTool("apply_patch", { input: "*** Begin Patch\n*** Update File: x.ts\n*** Add File: y.ts\n" }, "/repo").target).toBe("x.ts +1 more");
    const board = summarizeTools(
      [presentTool("kanban_list", {}, "/repo"), presentTool("kanban_claim", { card: "k3x9a2" }, "/repo"), presentTool("kanban_update", { column: "in_review", report: "Fixed" }, "/repo")].map(
        (presentation) => ({ presentation, failed: false }),
      ),
    );
    expect(board).toBe("3 board actions");
    const cu = [
      presentTool("computer_get_app_state", { app: "TextEdit" }, "/repo"),
      presentTool("computer_click", { app: "TextEdit", element_index: 42 }, "/repo"),
      presentTool("computer_type_text", { app: "Notes", text: "hello world!" }, "/repo"),
    ];
    expect(cu.map((p) => [p.verb, p.target, p.meta])).toEqual([
      ["Read TextEdit state", "", undefined],
      ["Clicked", "[42]", "in TextEdit"],
      ["Typed", "12 characters", "in Notes"],
    ]);
    expect(summarizeTools(cu.map((presentation) => ({ presentation, failed: false })))).toBe("Used TextEdit, Notes · 3 actions");
    expect(liveComputerApp([{ name: "computer_click", arguments: { app: "TextEdit" }, running: true }])).toBe("TextEdit");
    expect(liveComputerApp([{ name: "computer_click", arguments: { app: "TextEdit" }, running: false }])).toBeUndefined();
    expect(presentTool("kanban_update", { column: "in_review", report: "Fixed" }, "/repo")).toMatchObject({ verb: "Moved its card", target: "to in_review" });
  });

  it("reads a call's timeout from its arguments", () => {
    expect(toolTimeoutMs("bash", { command: "sleep 9", timeout: 120 })).toBe(120_000);
    expect(toolTimeoutMs("bash", { command: "ls" })).toBeUndefined();
    expect(toolTimeoutMs("bash", { command: "ls", timeout: 0 })).toBeUndefined();
    expect(toolTimeoutMs("invisible_browse", { url: "x", timeoutSeconds: 30, timeoutMs: 5000 })).toBe(30_000);
    expect(toolTimeoutMs("invisible_browse", { url: "x", timeoutMs: 5000 })).toBe(5000);
    // Only bash's bare `timeout` is known to be seconds; elsewhere the unit is unknown.
    expect(toolTimeoutMs("custom", { timeout: 5000 })).toBeUndefined();
  });
});

describe("layoutRun (Working/Worked accordion)", () => {
  const run = (events: SessionEvent[]) => deriveRuns(play(events)).at(-1)!;
  const toolTurn: SessionEvent[] = [
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: "go", timestamp: 1000 } },
    { type: "message_start", message: assistant([], "pending") },
    { type: "message_end", message: { ...assistant([{ type: "text", text: "Let me look." }, readCall], "toolUse"), timestamp: 1500 } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false },
  ];
  const streamAnswer = (text: string): SessionEvent[] => [
    { type: "message_start", message: { ...assistant([], "pending"), timestamp: 9000 } },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
  ];

  it("keeps the accordion open while tools run, with commentary inside the work", () => {
    const layout = layoutRun(run(toolTurn));
    expect(layout.settled).toBe(false);
    expect(layout.work.map((b) => b.kind)).toEqual(["text", "activity"]);
    expect(layout.final).toEqual([]);
    expect(layout.startedAt).toBe(1000);
  });

  it("stays open for short trailing commentary that may precede another tool call", () => {
    const layout = layoutRun(run([...toolTurn, ...streamAnswer("Now I'll check the tests.")]));
    expect(layout.final.map((b) => b.kind)).toEqual(["text"]);
    expect(layout.settled).toBe(false);
  });

  it("closes once the final answer is clearly streaming or its message stopped", () => {
    expect(layoutRun(run([...toolTurn, ...streamAnswer("x".repeat(400))])).settled).toBe(true);
    const done = layoutRun(run([...toolTurn, { type: "message_end", message: { ...assistant([{ type: "text", text: "Done." }]), timestamp: 9000 } }]));
    expect(done.settled).toBe(true);
    expect(done.endedAt).toBe(9000); // "Worked for" stops when the answer starts
    // Thinking at the start of the answer's message still counts as work: the clock stops when the
    // answer text starts, not when its message started.
    const thoughtFirst = layoutRun(
      run([
        ...toolTurn,
        { type: "message_start", message: { ...assistant([], "pending"), timestamp: 9000 } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hm" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "y".repeat(400) } },
      ]),
    );
    const answer = thoughtFirst.final[0];
    expect(answer?.kind === "text" && answer.at).toBeGreaterThan(0);
    expect(thoughtFirst.endedAt).toBe(answer?.kind === "text" ? answer.at : -1);
    expect(answer?.kind === "text" && answer.at).not.toBe(9000);
  });

  it("is settled for finished runs and has no work when no tools or thinking ran", () => {
    const plain = layoutRun(run([...userTurn("hi"), { type: "message_end", message: assistant([{ type: "text", text: "Hello" }]) }]));
    expect(plain.work).toEqual([]);
    expect(plain.settled).toBe(true);
  });
});

describe("needsTimeDivider", () => {
  const minute = 60_000;
  const turn = (userAt: number, answerAt?: number): Run => ({
    key: `r${userAt}`,
    live: false,
    user: { key: `u${userAt}`, message: { role: "user", content: "x", timestamp: userAt } },
    blocks: answerAt === undefined ? [] : [{ kind: "text", key: `t${answerAt}`, text: "ok", streaming: false, at: answerAt, stopReason: "stop" }],
  });
  const noon = new Date(2026, 9, 2, 12, 0).getTime();

  it("shows a divider for the first message and after a long break, measured from the end of the previous turn", () => {
    expect(needsTimeDivider(undefined, turn(noon))).toBe(true);
    expect(needsTimeDivider(turn(noon, noon + minute), turn(noon + 20 * minute))).toBe(false);
    // A long-running turn: 50 min after it started but only 5 min after it finished is not a break.
    expect(needsTimeDivider(turn(noon, noon + 45 * minute), turn(noon + 50 * minute))).toBe(false);
    expect(needsTimeDivider(turn(noon, noon + minute), turn(noon + 61 * minute))).toBe(true);
  });

  it("shows a divider when the day changes, even after a short gap", () => {
    const late = new Date(2026, 9, 2, 23, 55).getTime();
    expect(needsTimeDivider(turn(late, late + minute), turn(late + 10 * minute))).toBe(true);
  });
});

describe("steering", () => {
  const user = (text: string, timestamp = 5): SessionEvent => ({ type: "message_end", message: { role: "user", content: text, timestamp } });
  const toolTurnEvents: SessionEvent[] = [
    { type: "agent_start" },
    user("fix auth", 1),
    { type: "message_start", message: assistant([], "pending") },
    { type: "message_end", message: assistant([readCall], "toolUse") },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false },
    { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false, timestamp: 2 } },
  ];

  it("folds a message delivered after tool calls into the running turn as a steer step", () => {
    const state = play([...toolTurnEvents, user("no, check the tests first"), { type: "message_start", message: assistant([], "pending") }]);
    expect(state.items.filter((item) => item.kind === "user").map((item) => item.kind === "user" && Boolean(item.steer))).toEqual([false, true]);
    const runs = deriveRuns(state);
    expect(runs).toHaveLength(1);
    const steps = runs[0]?.blocks.flatMap((block) => (block.kind === "activity" ? block.steps.map((step) => step.kind) : []));
    expect(steps).toEqual(["tool", "steer"]);
    expect(layoutRun(runs[0] as Run).work.length).toBeGreaterThan(0);
  });

  it("uses pi's queue to tell a steer from a follow-up when the model had stopped", () => {
    const stopped: SessionEvent[] = [{ type: "agent_start" }, user("go", 1), { type: "message_end", message: assistant([{ type: "text", text: "done" }]) }];
    const steered = play([...stopped, { type: "queue_update", steering: ["redirect"], followUp: [] }, { type: "queue_update", steering: [], followUp: [] }, user("redirect")]);
    expect(deriveRuns(steered)).toHaveLength(1);
    const followed = play([...stopped, { type: "queue_update", steering: [], followUp: ["later"] }, user("later")]);
    expect(deriveRuns(followed)).toHaveLength(2);
  });

  it("never treats the first message of a new run as a steer, even after an aborted tool call", () => {
    const state = play([...toolTurnEvents, { type: "agent_settled" }, { type: "agent_start" }, user("new task")]);
    expect(deriveRuns(state)).toHaveLength(2);
  });

  it("classifies steers in sessions read from disk by the tool-use rule", () => {
    const entry = (id: string, message: unknown): SessionEntry => ({ type: "message", id, parentId: null, timestamp: "2026-10-01T10:00:00.000Z", message }) as SessionEntry;
    const state = hydrate(createSession("h", "/repo"), [
      entry("u1", { role: "user", content: "fix auth", timestamp: 1 }),
      entry("a1", assistant([readCall], "toolUse")),
      entry("t1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false, timestamp: 2 }),
      entry("u2", { role: "user", content: "steer", timestamp: 3 }),
      entry("a2", assistant([{ type: "text", text: "ok" }])),
      entry("u3", { role: "user", content: "next prompt", timestamp: 4 }),
    ]);
    expect(deriveRuns(state).map((run) => run.user?.message.content)).toEqual(["fix auth", "next prompt"]);
  });
});

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
});


describe("compaction lifecycle", () => {
  const finished: SessionEvent = { type: "compaction_end", reason: "manual", result: { summary: "Kept the important context.", tokensBefore: 120000 }, aborted: false, willRetry: false };
  const ready: HostEvent = { kind: "ready", state: { thinkingLevel: "high", isStreaming: false, isCompacting: true, steeringMode: "all", followUpMode: "all", sessionId: "x", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 } };

  it.each([false, true])("immediately puts active compaction in the chat (agent running: %s)", (running) => {
    const state = play([{ type: "compaction_start", reason: "manual" }], { ...createSession("h", "/repo"), running });
    expect(state.compacting).toMatchObject({ kind: "compaction", status: "running", reason: "manual", startedAt: expect.any(Number) });
    expect(state.items).toEqual([state.compacting]);
    expect(deriveRuns(state)[0]?.blocks).toEqual([state.compacting]);
    expect(attention(state)).toBe("running");
    expect(isDisposable(state)).toBe(false);
  });

  it("completes the same inline record without moving or duplicating it", () => {
    const state = play([{ type: "compaction_start", reason: "manual" }]);
    const done = play([{ type: "message_end", message: assistant([{ type: "text", text: "Later activity" }]) }, finished], state);
    expect(done.compacting).toBeUndefined();
    expect(done.items).toHaveLength(2);
    expect(done.items[0]).toMatchObject({ key: state.compacting?.key, status: "done", summary: "Kept the important context.", tokensBefore: 120000, endedAt: expect.any(Number) });
  });

  it.each([
    { aborted: false, errorMessage: "Rate limit reached", status: "error" },
    { aborted: true, errorMessage: undefined, status: "aborted" },
  ])("records $status instead of leaving a spinner", ({ aborted, errorMessage, status }) => {
    const state = play([{ type: "compaction_start", reason: "overflow" }]);
    const done = play([{ type: "compaction_end", reason: "overflow", aborted, errorMessage, willRetry: false }], state);
    expect(done.compacting).toBeUndefined();
    expect(done.items).toHaveLength(1);
    expect(done.items[0]).toMatchObject({ key: state.compacting?.key, status });
    if (errorMessage) expect(runOutcome(done.items)).toBe("error");
  });

  it.each<SessionEvent | HostEvent>([
    { type: "agent_settled" },
    { kind: "exit", code: 1, signal: null, stderrTail: "crash" },
  ])("finalizes pending compaction on interruption or process exit: %j", (event) => {
    const state = play([{ type: "compaction_start", reason: "threshold" }]);
    const done = play([event], state);
    expect(done.compacting).toBeUndefined();
    expect(done.items[0]).toMatchObject({ key: state.compacting?.key, status: "aborted", endedAt: expect.any(Number) });
  });

  it("recovers from ready.isCompacting and reuses it when start arrives", () => {
    const state = play([ready]);
    expect(state.compacting?.status).toBe("running");
    const started = play([{ type: "compaction_start", reason: "manual" }, ready], state);
    expect(started.items).toHaveLength(1);
    expect(started.compacting).toMatchObject({ key: state.compacting?.key, reason: "manual", startedAt: state.compacting?.startedAt });
    expect(play([finished], started).items[0]).toMatchObject({ status: "done" });
  });

  it("does not resurrect a finished compaction from a delayed ready snapshot", () => {
    const state = play([{ type: "compaction_start", reason: "manual" }, finished]);
    const recovered = play([ready], state);
    expect(recovered.compacting).toBeUndefined();
    expect(recovered.items).toEqual(state.items);
  });

  it("handles missing start events and successive compactions", () => {
    const done = play([finished, { type: "compaction_start", reason: "threshold" }, { ...finished, reason: "threshold" }]);
    expect(done.items.map((item) => item.kind === "compaction" && item.status)).toEqual(["done", "done"]);
    expect(new Set(done.items.map((item) => item.key)).size).toBe(2);
  });

  it("hydrates completed records and retains a compaction already in progress", () => {
    const state = play([ready]);
    const hydrated = hydrate(state, [{ type: "compaction", id: "c", parentId: null, timestamp: "", summary: "Earlier summary", tokensBefore: 100, firstKeptEntryId: "u" }]);
    expect(hydrated.items.map((item) => item.kind === "compaction" && item.status)).toEqual(["done", "running"]);
    expect(hydrated.items.at(-1)).toBe(hydrated.compacting);
    expect(new Set(hydrated.items.map((item) => item.key)).size).toBe(2);
    expect(play([finished], hydrated).items.map((item) => item.kind === "compaction" && item.status)).toEqual(["done", "done"]);
  });

  it("shows summarization retries only within the active compaction", () => {
    const scheduled: SessionEvent = { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429" };
    expect(play([scheduled]).items).toEqual([]);
    const state = play([{ type: "compaction_start", reason: "manual" }, scheduled]);
    expect(state.compacting?.retry).toMatchObject({ attempt: 1, maxAttempts: 3, waiting: true, errorMessage: "429" });
    const retrying = play([{ type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" }], state);
    expect(retrying.compacting?.retry?.waiting).toBe(false);
    const unrelated = play([{ type: "summarization_retry_attempt_start", source: "branchSummary" }], state);
    expect(unrelated.compacting).toBe(state.compacting);
    const finishedRetry = play([{ type: "summarization_retry_finished" }], retrying);
    expect(finishedRetry.compacting?.retry).toBeUndefined();
    expect(finishedRetry.items).toHaveLength(1);
    expect(finishedRetry.items[0]).toBe(finishedRetry.compacting);
  });
});
