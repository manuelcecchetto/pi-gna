import { describe, expect, it } from "vitest";
import type { HostEvent } from "../../../shared/ipc";
import type { AssistantMessage, SessionEntry, SessionEvent, ToolCall } from "../../../shared/protocol";
import { createSession, hydrate, reduceHostEvent, type SessionState } from "./session";
import { presentTool, summarizeTools } from "./tools";
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
