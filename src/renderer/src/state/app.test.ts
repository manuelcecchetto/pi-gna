import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "../../../shared/protocol";
import { createSession, reduceSessionEvent } from "../lib/session";
import { interrupt, store } from "./app";

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
