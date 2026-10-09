import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SessionEvent, ToolCall } from "../../../shared/protocol";
import { createSession, reduceSessionEvent, type SessionState } from "../../../shared/session-state";
import { createRunDeriver, layoutRun } from "../lib/view";
import { WorkAccordion } from "./Activity";

vi.mock("../lib/chat-ui", () => ({
  useChatUi: (selector: (state: unknown) => unknown) => selector({ expanded: {}, expandAll: false }),
  useChatActions: () => ({ homeDir: "/home", setExpanded: () => undefined, openLightbox: () => undefined }),
}));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", {}, text) }));

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 1 });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const play = (events: SessionEvent[], start: SessionState = createSession("h", "/repo")) => events.reduce((state, event, index) => reduceSessionEvent(state, event, 1000 + index * 100), start);
const done = (id: string, name: string, isError = false, details?: unknown): SessionEvent[] => [
  { type: "tool_execution_start", toolCallId: id, toolName: name, args: {} },
  { type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: "out" }], details }, isError },
];

describe("WorkAccordion", () => {
  it("reads the same summary and rows after a live rebuild that kept unchanged steps", () => {
    const derive = createRunDeriver();
    const render = (state: SessionState) => {
      const run = derive(state).at(-1)!;
      return renderToStaticMarkup(createElement(WorkAccordion, { run, layout: layoutRun(run), cwd: "/repo", home: "/home", renderBlock: () => null }));
    };
    const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const state = play([
      { type: "agent_start" },
      { type: "message_end", message: { role: "user", content: "go", timestamp: 1 } },
      { type: "message_end", message: assistant([call("c1", "bash", { command: "make" }), call("c2", "edit", { path: "/repo/src/b.ts" }), call("c3", "bash", { command: "make test" })]) },
      ...done("c1", "bash", true),
      ...done("c2", "edit", false, { diff: "+1 a\n-1 b\n+2 c" }),
      { type: "tool_execution_start", toolCallId: "c3", toolName: "bash", args: {} },
    ]);
    const before = text(render(state));
    expect(before).toContain("· Ran 2 commands · edited 1 file · 1 failed");
    expect(before).toMatch(/Ran make failed .*Edited src\/b\.ts \+2 −1 .*Running make test/);
    const updated = play([{ type: "tool_execution_update", toolCallId: "c3", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "1 passed" }] } }], state);
    expect(text(render(updated))).toBe(before);
    const ended = play(done("c3", "bash", true).slice(1), updated);
    expect(text(render(ended))).toContain("· Ran 2 commands · edited 1 file · 2 failed");
  });
});
