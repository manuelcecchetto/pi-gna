import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATP_CONFIG, parseClaim, parsePlan } from "../../../shared/atp";
import type { RpcCommand } from "../../../shared/protocol";
import { handleBatch, store } from "./app";
import { atpStore, startPlan, stopPlan } from "./atp";

vi.mock("../lib/layout", () => ({ loadSidebar: () => ({ width: 268, collapsed: false }), saveSidebar: vi.fn() }));

const PLAN = "/repo/big.atp.json";
type Raw = { title: string; instruction: string; dependencies: string[]; status: string; worker_id?: string };
let nodes: Record<string, Raw>;
/** What a worker does with its node when it gets a prompt: finish it, or end its run with the node still claimed. */
let worker: "complete" | "idle" | "hang";
let held: string[];
const heldListeners: ((plans: string[]) => void)[] = [];
const prompts: { handle: string; message: string }[] = [];

const later = (fn: () => void) => setTimeout(fn, 0);
const settle = (handle: string) => later(() => handleBatch({ handle, events: [{ kind: "rpc", record: { type: "agent_settled" } }] }));

const studio = {
  command: vi.fn(async (handle: string, cmd: RpcCommand) => {
    if (cmd.type === "prompt") {
      prompts.push({ handle, message: cmd.message });
      const node = Object.entries(nodes).find(([, other]) => other.status === "CLAIMED")?.[0];
      if (worker === "complete" && node) {
        (nodes[node] as Raw).status = "COMPLETED";
        for (const other of Object.values(nodes)) if (other.status === "LOCKED" && other.dependencies.every((dep) => nodes[dep]?.status === "COMPLETED")) other.status = "READY";
      }
      if (worker !== "hang") settle(handle);
    }
    return { type: "response", command: cmd.type, success: true, data: {} };
  }),
  openSession: vi.fn(async ({ handle }: { handle: string }) => {
    later(() => handleBatch({ handle, events: [{ kind: "ready", state: { sessionFile: `/atp-sessions/${handle}.jsonl`, messageCount: 0 } as never }] }));
    return { entries: [] };
  }),
  closeSession: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
  atp: {
    info: async () => ({ librarian: "/app/librarian.py" }),
    activate: vi.fn(async () => "Project activated"),
    read: async () => parsePlan(PLAN, { meta: { project_status: "ACTIVE" }, nodes: structuredClone(nodes) }),
    claim: vi.fn(async (_plan: string, agent: string) => {
      if (held.includes(PLAN)) return { kind: "held", message: "paused" };
      const mine = Object.entries(nodes).find(([, node]) => node.status === "CLAIMED" && node.worker_id === agent);
      const next = mine ?? Object.entries(nodes).find(([, node]) => node.status === "READY");
      if (!next) return parseClaim("NO_TASKS_AVAILABLE: All tasks are blocked, claimed, or the project is finished.");
      Object.assign(next[1], { status: "CLAIMED", worker_id: agent });
      return parseClaim(`TASK ASSIGNED: ${next[0]} - ${next[1].title}\nSTATUS: CLAIMED\nINSTRUCTION:\n${next[1].instruction}`);
    }),
    release: vi.fn(async (_plan: string, node: string) => {
      Object.assign(nodes[node] as Raw, { status: "READY", worker_id: undefined });
      return "released";
    }),
    head: async () => ({ sha: "abc", branch: "main" }),
    commit: vi.fn(async () => ({ kind: "committed", sha: "def4567890" })),
    held: async () => held,
    onHeld: (listener: (plans: string[]) => void) => heldListeners.push(listener),
    onPlans: () => () => undefined,
  },
};

const setHeld = (plans: string[]) => {
  held = plans;
  for (const listener of heldListeners) listener(plans);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { studio });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  nodes = {
    T1: { title: "First", instruction: "Do one", dependencies: [], status: "READY" },
    T2: { title: "Second", instruction: "Do two", dependencies: ["T1"], status: "LOCKED" },
  };
  worker = "complete";
  held = [];
  prompts.length = 0;
  for (const mock of [studio.command, studio.openSession, studio.closeSession, studio.atp.claim, studio.atp.release, studio.atp.commit]) mock.mockClear();
  store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined, page: undefined, toasts: [], models: [] }));
  atpStore.set(() => ({ held: [], runners: {}, notes: {}, orchestrators: {} }));
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the ATP runner", () => {
  it("runs the plan node by node, each in a fresh hidden worker chat, committing after each", async () => {
    const run = startPlan(PLAN, "/repo");
    await vi.runAllTimersAsync();
    await run;
    expect(studio.atp.activate).toHaveBeenCalledOnce();
    expect(prompts.map((prompt) => prompt.message.match(/TASK ASSIGNED: (\S+)/)?.[1])).toEqual(["T1", "T2"]);
    expect(new Set(prompts.map((prompt) => prompt.handle)).size).toBe(2);
    expect(prompts[0]?.message).toContain(`- agent_id: ${ATP_CONFIG.agentId}`);
    const opened = studio.openSession.mock.calls.map(([request]) => request as { atp?: unknown });
    expect(opened.map((request) => request.atp)).toEqual([
      { role: "worker", plan: PLAN, node: "T1" },
      { role: "worker", plan: PLAN, node: "T2" },
    ]);
    expect(studio.atp.commit).toHaveBeenCalledTimes(2);
    expect(studio.closeSession).toHaveBeenCalledTimes(2);
    expect(atpStore.get().runners[PLAN]).toBeUndefined();
    expect(atpStore.get().notes[PLAN]?.text).toBe("Finished: every node is completed.");
  });

  it("nudges a worker that ended with its node claimed once, then releases the node and stops", async () => {
    worker = "idle";
    const run = startPlan(PLAN, "/repo");
    await vi.runAllTimersAsync();
    await run;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.message).toMatch(/still CLAIMED/);
    expect(studio.atp.release).toHaveBeenCalledOnce();
    expect(nodes.T1?.status).toBe("READY");
    expect(atpStore.get().notes[PLAN]?.level).toBe("error");
    // Its pi stops; the node keeps the chat, to read why.
    expect(studio.closeSession).toHaveBeenCalledOnce();
    expect(studio.atp.commit).not.toHaveBeenCalled();
  });

  it("stops: the worker goes, its node goes back to READY and nothing else is claimed", async () => {
    worker = "hang";
    const run = startPlan(PLAN, "/repo");
    await vi.runAllTimersAsync();
    expect(atpStore.get().runners[PLAN]?.phase).toBe("working");
    await stopPlan(PLAN);
    await vi.runAllTimersAsync();
    await run;
    expect(studio.closeSession).toHaveBeenCalledOnce();
    expect(studio.atp.release).toHaveBeenCalledOnce();
    expect(nodes.T1?.status).toBe("READY");
    expect(studio.atp.claim).toHaveBeenCalledOnce();
    expect(atpStore.get().runners[PLAN]).toBeUndefined();
  });

  it("waits while the orchestrator pauses the plan, and goes on when it resumes", async () => {
    setHeld([PLAN]);
    const run = startPlan(PLAN, "/repo");
    await vi.runAllTimersAsync();
    expect(atpStore.get().runners[PLAN]?.phase).toBe("held");
    expect(prompts).toHaveLength(0);
    setHeld([]);
    await vi.runAllTimersAsync();
    await run;
    expect(prompts).toHaveLength(2);
  });

  it("gives an interrupted node back to the same worker agent, told to check what the last run left", async () => {
    Object.assign(nodes.T1 as Raw, { status: "CLAIMED", worker_id: ATP_CONFIG.agentId });
    const run = startPlan(PLAN, "/repo");
    await vi.runAllTimersAsync();
    await run;
    expect(prompts[0]?.message).toMatch(/An earlier run of this node stopped/);
    expect(prompts[1]?.message).not.toMatch(/An earlier run/);
  });
});
