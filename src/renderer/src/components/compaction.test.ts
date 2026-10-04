import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SessionEvent } from "../../../shared/protocol";
import { createSession, reduceSessionEvent } from "../../../shared/session-state";
import { CompactionProgress } from "./CompactionProgress";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

const app = vi.hoisted(() => ({ expanded: {} as Record<string, boolean>, expandAll: false, commands: {}, annotations: [], attachments: {}, models: [], levels: {}, compaction: {} }));
vi.mock("../state/app", () => ({ useApp: (selector: (state: typeof app) => unknown) => selector(app), composerCard: () => undefined }));
// The transcript reads its state and actions through the ChatUi context (lib/chat-ui.tsx); here from the same fake app state.
vi.mock("../lib/chat-ui", () => ({
  useChatUi: (selector: (state: unknown) => unknown) => selector({ ...app, board: { cards: [] }, settings: { visuals: false, wallpaper: "none", wallpaperLoop: false } }),
  useChatActions: () => ({ homeDir: "/home", setExpanded: () => undefined, openLightbox: () => undefined, openExternal: () => undefined, respondDialog: async () => undefined, editQueue: async () => false }),
}));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", {}, text) }));
vi.mock("./ContextMeter", () => ({ ContextMeter: () => null }));
vi.mock("./Dialogs", () => ({ Dialogs: () => null }));
vi.mock("./QueueCard", () => ({ QueueCard: () => null }));

const assistant = (id: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `/repo/${id}.ts` } }],
  api: "x", provider: "p", model: "m", stopReason: "toolUse", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const play = (events: SessionEvent[]) => events.reduce((state, event, index) => reduceSessionEvent(state, event, 1000 + index * 100), createSession("h", "/repo"));
const started: SessionEvent = { type: "compaction_start", reason: "manual" };
const ended: SessionEvent = { type: "compaction_end", reason: "manual", result: { summary: "Important summary", tokensBefore: 120000 }, aborted: false, willRetry: false };

beforeEach(() => {
  app.expanded = {};
  vi.stubGlobal("window", { studio: { homeDir: "/home" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("visible compaction UI", () => {
  it.each([false, true])("shows compaction once, only in the chat (agent running: %s)", (running) => {
    const state = { ...play([started]), running };
    const transcript = renderToStaticMarkup(createElement(Transcript, { session: state }));
    const composer = renderToStaticMarkup(createElement(Composer, { session: state }));
    expect(transcript).toContain("Compacting context…");
    expect(transcript.match(/Compacting context/g)).toHaveLength(1);
    expect(transcript).not.toContain("· compacting context");
    expect(composer).not.toContain("Compacting context");
    expect(composer).toContain('title="Stop (Esc twice)"');
    expect(transcript).toContain('aria-live="polite"');
  });

  it("shows retry progress without putting the ticking elapsed time in the live announcement", () => {
    const state = play([started, { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429" }]);
    const markup = renderToStaticMarkup(createElement(CompactionProgress, { item: state.compacting! }));
    expect(markup).toContain("waiting to retry (1/3)");
    expect(markup).toMatch(/aria-atomic="true">Compacting context[^<]+<\/span>/);
    const retrying = reduceSessionEvent(state, { type: "summarization_retry_attempt_start", source: "compaction" }, 2000);
    expect(renderToStaticMarkup(createElement(CompactionProgress, { item: retrying.compacting! }))).toContain("retrying (1/3)");
  });

  it.each([
    [ended, "Context compacted", "tokens before compaction"],
    [{ ...ended, result: undefined, errorMessage: "Rate limit reached" }, "Compaction failed:", "Rate limit reached"],
    [{ ...ended, result: undefined, aborted: true }, "Context compaction interrupted", "interrupted"],
  ] as const)("keeps the outcome visible after later tools are collapsed: %j", (end, label, detail) => {
    const state = play([{ type: "message_end", message: assistant("before") }, started, end, { type: "message_end", message: assistant("after") }, { type: "agent_settled" }]);
    const markup = renderToStaticMarkup(createElement(Transcript, { session: state }));
    expect(markup).toContain("Worked");
    expect(markup).not.toContain("before.ts");
    expect(markup).not.toContain("after.ts");
    expect(markup).toContain(label);
    expect(markup).toContain(detail);
    expect(markup).not.toContain('data-compaction="running"');
    expect(renderToStaticMarkup(createElement(Composer, { session: state }))).not.toContain("Compacting context");
  });

  it("does not show a stale tool row when work is collapsed during compaction", () => {
    const state = play([{ type: "agent_start" }, { type: "message_end", message: assistant("before") }, started]);
    app.expanded["work:i1:working"] = false;
    const markup = renderToStaticMarkup(createElement(Transcript, { session: state }));
    expect(markup).toContain("Compacting context…");
    expect(markup).not.toContain("before.ts");
  });
});
