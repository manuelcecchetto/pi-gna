import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSessionResult, SessionSummary } from "../../../shared/ipc";
import type { RpcCommand, SessionEntry } from "../../../shared/protocol";
import { createSession, reduceSessionEvent } from "../lib/session";
import { interrupt, openSession, sessionTitle, store } from "./app";

vi.mock("../lib/layout", () => ({ loadSidebar: () => ({ width: 268, collapsed: false }), saveSidebar: vi.fn() }));
const command = vi.fn(async (_handle: string, cmd: RpcCommand) => ({
  type: "response", command: cmd.type, success: true,
  data: cmd.type === "clear_queue" ? { steering: ["queued steer"], followUp: ["queued follow-up"] } : {},
}));

beforeEach(() => {
  vi.useFakeTimers();
  command.mockClear();
  vi.stubGlobal("window", { studio: { command } });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("interrupt action", () => {
  it.each(["manual compaction", "agent run"])("aborts %s through RPC", async (operation) => {
    const session = operation === "manual compaction"
      ? reduceSessionEvent(createSession("h", "/repo"), { type: "compaction_start", reason: "manual" }, 1000)
      : { ...createSession("h", "/repo"), running: true };
    store.set((s) => ({ ...s, sessions: { h: session } }));
    expect(await interrupt("h")).toEqual([]);
    expect(command).toHaveBeenCalledExactlyOnceWith("h", { type: "abort" });
  });

  it("restores queues before aborting manual compaction", async () => {
    const session = reduceSessionEvent(createSession("h", "/repo"), { type: "compaction_start", reason: "manual" }, 1000);
    store.set((s) => ({ ...s, sessions: { h: { ...session, queue: { steering: ["queued steer"], followUp: ["queued follow-up"] } } } }));
    expect(await interrupt("h")).toEqual(["queued steer", "queued follow-up"]);
    expect(command.mock.calls.map(([, cmd]) => cmd.type)).toEqual(["clear_queue", "abort"]);
  });

  it("does nothing for an idle or missing session", async () => {
    store.set((s) => ({ ...s, sessions: { h: createSession("h", "/repo") } }));
    expect(await interrupt("h")).toEqual([]);
    expect(await interrupt("missing")).toEqual([]);
    expect(command).not.toHaveBeenCalled();
  });
});

describe("opening a chat from the sidebar", () => {
  const summary: SessionSummary = { path: "/s/a.jsonl", id: "a", cwd: "/repo", title: "Fix the flash", named: false, createdAt: 0, modifiedAt: 0 };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "fix the flash please", timestamp: 1 } } as SessionEntry;

  it("is loading under the sidebar's title until its history arrives, not an empty chat", async () => {
    let read!: (result: OpenSessionResult) => void;
    const open = vi.fn(() => new Promise<OpenSessionResult>((resolve) => (read = resolve)));
    vi.stubGlobal("window", { studio: { command, openSession: open } });
    openSession(summary);
    const handle = store.get().active ?? "";
    const opened = store.get().sessions[handle];
    expect(opened?.sessionPath).toBe(summary.path);
    expect(opened?.loading).toEqual({ title: "Fix the flash" });
    expect(opened && sessionTitle(opened)).toBe("Fix the flash");

    read({ entries: [entry] });
    await vi.runAllTimersAsync();
    const loaded = store.get().sessions[handle];
    expect(loaded?.loading).toBeUndefined();
    expect(loaded?.items.map((item) => item.kind)).toEqual(["user"]);
    expect(loaded && sessionTitle(loaded)).toBe("fix the flash please");
  });
});
