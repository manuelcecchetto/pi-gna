import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATP_CONFIG, parseClaim, parsePlan } from "../shared/atp";
import type { AtpRunnerState } from "../shared/host-api";
import type { RunOutcome } from "../shared/session-state";
import { emptySettings } from "../shared/settings";
import { AtpRuns } from "./atp-runner";
import { AtpThreads } from "./atp-threads";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const PLAN = "/repo/big.atp.json";
const client = { clientId: "w", actor: "desktop" } as const;
type Raw = { title: string; instruction: string; dependencies: string[]; status: string; worker_id?: string };

/** The chat's slice of SessionState that the runner reads. */
interface FakeChat {
  cwd: string;
  sessionPath: string;
  running: boolean;
  prompted: boolean;
  compacting: boolean;
  dialogs: unknown[];
  items: unknown[];
}

/**
 * A runner with a librarian, chats and git that are fakes. `worker` says what a worker does with the node when it gets a
 * prompt: finish it, end its run with the node still claimed, or run forever.
 */
function harness() {
  const nodes: Record<string, Raw> = {
    T1: { title: "First", instruction: "Do one", dependencies: [], status: "READY" },
    T2: { title: "Second", instruction: "Do two", dependencies: ["T1"], status: "LOCKED" },
  };
  const state = { worker: "complete" as "complete" | "idle" | "hang", held: false, launchFails: false, activateError: undefined as string | undefined };
  const chats = new Map<string, FakeChat>();
  const viewing = new Set<string>();
  const attached = new Map<string, Set<string>>();
  const prompts: { handle: string; message: string }[] = [];
  const launched: { cwd: string; atp: unknown; name: string; model: unknown }[] = [];
  const closed: string[] = [];
  const published: AtpRunnerState[] = [];
  const settle: ((handle: string, outcome: RunOutcome) => void)[] = [];
  const exit: ((handle: string) => void)[] = [];
  const presence: ((handle: string) => void)[] = [];
  let count = 0;

  const unlock = () => {
    for (const other of Object.values(nodes)) if (other.status === "LOCKED" && other.dependencies.every((dep) => nodes[dep]?.status === "COMPLETED")) other.status = "READY";
  };
  const settleLater = (handle: string, outcome: RunOutcome = "done") =>
    setTimeout(() => {
      const chat = chats.get(handle);
      if (chat) chat.running = false;
      for (const listener of settle) listener(handle, outcome);
    }, 0);
  const remove = (handle: string) => {
    chats.delete(handle);
    for (const listener of exit) listener(handle);
  };

  const host = {
    open: vi.fn(async (request: { cwd: string; sessionPath?: string }, lease?: { client?: { clientId: string } }) => {
      const handle = `chat${++count}`;
      chats.set(handle, { cwd: request.cwd, sessionPath: request.sessionPath ?? `/atp-sessions/${handle}.jsonl`, running: false, prompted: false, compacting: false, dialogs: [], items: [] });
      if (lease?.client) attached.set(handle, new Set([lease.client.clientId]));
      return { handle, entries: [] };
    }),
    attach: vi.fn((handle: string, who: { clientId: string }) => void (attached.get(handle) ?? attached.set(handle, new Set()).get(handle))?.add(who.clientId)),
    detach: vi.fn((handle: string, clientId: string) => {
      attached.get(handle)?.delete(clientId);
      for (const listener of presence) listener(handle);
    }),
    command: vi.fn(async (handle: string, command: { type: string; message?: string }) => {
      const chat = chats.get(handle);
      if (command.type === "prompt" && chat) {
        prompts.push({ handle, message: command.message ?? "" });
        chat.prompted = true;
        const node = Object.entries(nodes).find(([, other]) => other.status === "CLAIMED")?.[0];
        if (state.worker === "complete" && node) {
          (nodes[node] as Raw).status = "COMPLETED";
          unlock();
        }
        if (state.worker === "hang") chat.running = true;
        else settleLater(handle);
      }
      return { type: "response", command: command.type, success: true, data: {} };
    }),
    stateOf: vi.fn((handle: string) => chats.get(handle)),
    presence: vi.fn((handle: string) => [
      ...[...(attached.get(handle) ?? [])].map((clientId) => ({ clientId, actor: "desktop", viewing: viewing.has(handle) })),
      ...(viewing.has(handle) && !attached.get(handle)?.size ? [{ clientId: "w", actor: "desktop", viewing: true }] : []),
    ]),
    close: vi.fn(async (handle: string) => {
      closed.push(handle);
      remove(handle);
    }),
    interrupt: vi.fn(async (handle: string) => {
      settleLater(handle, "error");
      return [];
    }),
    identify: vi.fn(async (handle: string) => ({ path: chats.get(handle)?.sessionPath ?? "/none.jsonl", cwd: "/repo" })),
    onSettled: (listener: (handle: string, outcome: RunOutcome) => void) => void settle.push(listener),
    onExit: (listener: (handle: string) => void) => void exit.push(listener),
    onPresence: (listener: (handle: string) => void) => void presence.push(listener),
  };
  const tasks = {
    launch: vi.fn(async (setup: { cwd: string; atp?: unknown; name: string; prompt: string; model?: unknown }) => {
      const { handle } = await host.open({ cwd: setup.cwd });
      launched.push({ cwd: setup.cwd, atp: setup.atp, name: setup.name, model: setup.model });
      if (state.launchFails) return { handle, failed: "no api key" };
      await host.command(handle, { type: "prompt", message: setup.prompt });
      return { handle };
    }),
    useModel: vi.fn(async () => undefined),
  };
  const atp = {
    activate: vi.fn(async () => {
      if (state.activateError) throw new Error(state.activateError);
      return "Project activated";
    }),
    read: vi.fn(async () => parsePlan(PLAN, { meta: { project_status: "ACTIVE" }, nodes: structuredClone(nodes) })),
    claim: vi.fn(async (_plan: string, agent: string) => {
      if (state.held) return { kind: "held" as const, message: "paused" };
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
    head: vi.fn(async () => ({ sha: "abc", branch: "main" })),
    commit: vi.fn(async () => ({ kind: "committed" as const, sha: "def4567890" })),
    setHeld: vi.fn(),
  };
  const threads = { get: vi.fn(async () => ({ workers: {} as Record<string, string[]> })), remember: vi.fn(async (_plan: string, _node: string, _path: string) => undefined), setOrchestrator: vi.fn(async (_plan: string, _path: string) => undefined) };
  const runs = new AtpRuns({
    host: host as never,
    tasks: tasks as never,
    atp: atp as never,
    threads: threads as never,
    settings: { get: async () => emptySettings() },
    librarian: "/app/librarian.py",
    shellEnv: Promise.resolve(),
    publish: (next) => published.push(next),
  });
  return { runs, nodes, state, chats, viewing, attached, prompts, launched, closed, published, host, tasks, atp, threads, settle: settleLater, setHeld: (held: boolean) => ((state.held = held), runs.heldChanged()) };
}

type Harness = ReturnType<typeof harness>;
let h: Harness;
beforeEach(() => {
  h = harness();
});

const taskOf = (message: string) => message.match(/TASK ASSIGNED: (\S+)/)?.[1];

describe("the ATP runner", () => {
  it("runs the plan node by node, each in a fresh worker chat, committing after each, then closes the chats", async () => {
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.atp.activate).toHaveBeenCalledOnce();
    expect(h.prompts.map((prompt) => taskOf(prompt.message))).toEqual(["T1", "T2"]);
    expect(new Set(h.prompts.map((prompt) => prompt.handle)).size).toBe(2);
    expect(h.prompts[0]?.message).toContain(`- agent_id: ${ATP_CONFIG.agentId}`);
    expect(h.prompts[0]?.message).toContain("/app/librarian.py");
    expect(h.launched.map((launch) => launch.atp)).toEqual([
      { role: "worker", plan: PLAN, node: "T1" },
      { role: "worker", plan: PLAN, node: "T2" },
    ]);
    expect(h.launched[0]?.name).toBe("ATP T1: First");
    expect(h.atp.commit).toHaveBeenCalledTimes(2);
    expect(h.atp.commit).toHaveBeenCalledWith("/repo", "T1", "First", { sha: "abc", branch: "main" });
    expect(h.closed).toHaveLength(2);
    // Each worker chat's session file is kept with its node.
    expect(h.threads.remember.mock.calls.map(([plan, node]) => [plan, node])).toEqual([
      [PLAN, "T1"],
      [PLAN, "T2"],
    ]);
    const state = h.runs.state();
    expect(state.runners[PLAN]).toBeUndefined();
    expect(state.notes[PLAN]?.text).toBe("Finished: every node is completed.");
    // Every phase went out to the clients as it happened.
    expect(h.published.map((published) => published.runners[PLAN]?.phase)).toEqual(expect.arrayContaining(["starting", "claiming", "working", "committing"]));
    expect(h.published.find((published) => published.runners[PLAN]?.phase === "working")?.runners[PLAN]).toMatchObject({ node: "T1", title: "First", cwd: "/repo" });
  });

  it("starting twice runs the plan once", async () => {
    h.runs.start(PLAN, "/repo");
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.atp.activate).toHaveBeenCalledOnce();
    expect(h.prompts).toHaveLength(2);
  });

  it("says so when there is nothing to claim, and starts no worker", async () => {
    for (const node of Object.values(h.nodes)) node.status = "COMPLETED";
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.tasks.launch).not.toHaveBeenCalled();
    expect(h.runs.state().notes[PLAN]).toMatchObject({ level: "info", text: "Finished: every node is completed." });
  });

  it("names the failed node when nothing else can be claimed", async () => {
    Object.assign(h.nodes.T1 as Raw, { status: "FAILED" });
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.runs.state().notes[PLAN]).toMatchObject({ level: "error", text: expect.stringContaining("T1 failed") });
  });

  it("stops with the librarian's message when the plan is not active", async () => {
    h.atp.claim.mockResolvedValueOnce({ kind: "inactive", message: "The plan is a DRAFT" } as never);
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.tasks.launch).not.toHaveBeenCalled();
    expect(h.runs.state().notes[PLAN]).toMatchObject({ level: "error", text: "The plan is a DRAFT" });
    h.atp.activate.mockRejectedValueOnce(new Error("python3 is not installed"));
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.runs.state().notes[PLAN]?.text).toBe("python3 is not installed");
  });

  it("nudges a worker that ended with its node claimed once, then releases the node and stops", async () => {
    h.state.worker = "idle";
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]?.message).toMatch(/still CLAIMED/);
    expect(h.atp.release).toHaveBeenCalledOnce();
    expect(h.nodes.T1?.status).toBe("READY");
    expect(h.runs.state().notes[PLAN]?.level).toBe("error");
    // Its pi stops; the node keeps the chat, to read why.
    expect(h.closed).toHaveLength(1);
    expect(h.atp.commit).not.toHaveBeenCalled();
    expect(h.threads.remember).toHaveBeenCalledOnce();
  });

  it("releases the node when the worker could not be started", async () => {
    h.state.launchFails = true;
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.atp.release).toHaveBeenCalledOnce();
    expect(h.nodes.T1?.status).toBe("READY");
    expect(h.runs.state().notes[PLAN]).toMatchObject({ level: "error", text: expect.stringContaining("no api key") });
    expect(h.closed).toHaveLength(1);
  });

  it("stops: the worker is aborted, its node goes back to READY and nothing else is claimed", async () => {
    h.state.worker = "hang";
    h.runs.start(PLAN, "/repo");
    await vi.waitFor(() => expect(h.runs.state().runners[PLAN]?.phase).toBe("working"));
    await vi.waitFor(() => expect(h.runs.state().runners[PLAN]?.handle).toBeDefined());
    await h.runs.stop(PLAN);
    await h.runs.whenIdle(PLAN);
    expect(h.host.interrupt).toHaveBeenCalledOnce();
    expect(h.atp.release).toHaveBeenCalledOnce();
    expect(h.nodes.T1?.status).toBe("READY");
    expect(h.atp.claim).toHaveBeenCalledOnce();
    expect(h.runs.state().runners[PLAN]).toBeUndefined();
    expect(h.closed).toHaveLength(1);
  });

  it("waits while the orchestrator pauses the plan, and goes on when it resumes", async () => {
    h.state.held = true;
    h.runs.start(PLAN, "/repo");
    await vi.waitFor(() => expect(h.runs.state().runners[PLAN]?.phase).toBe("held"));
    expect(h.prompts).toHaveLength(0);
    h.setHeld(false);
    await h.runs.whenIdle(PLAN);
    expect(h.prompts).toHaveLength(2);
  });

  it("stops a run that waits for the orchestrator", async () => {
    h.state.held = true;
    h.runs.start(PLAN, "/repo");
    await vi.waitFor(() => expect(h.runs.state().runners[PLAN]?.phase).toBe("held"));
    await h.runs.stop(PLAN);
    await h.runs.whenIdle(PLAN);
    expect(h.prompts).toHaveLength(0);
  });

  it("gives an interrupted node back to the same worker agent, told to check what the last run left", async () => {
    Object.assign(h.nodes.T1 as Raw, { status: "CLAIMED", worker_id: ATP_CONFIG.agentId });
    h.runs.start(PLAN, "/repo");
    await h.runs.whenIdle(PLAN);
    expect(h.prompts[0]?.message).toMatch(/An earlier run of this node stopped/);
    expect(h.prompts[1]?.message).not.toMatch(/An earlier run/);
  });

  it("releases an interrupted claim on request, and lifts a pause", async () => {
    await h.runs.releaseInterrupted(PLAN, "T1");
    expect(h.atp.release).toHaveBeenCalledWith(PLAN, "T1", ATP_CONFIG.agentId, expect.stringContaining("interrupted"));
    h.runs.liftHold(PLAN);
    expect(h.atp.setHeld).toHaveBeenCalledWith(PLAN, false);
  });

  it("keeps the worker chat open while a client looks at it, and closes it once none does", async () => {
    h.viewing.add("chat1");
    h.attached.set("chat1", new Set(["w"]));
    h.runs.start(PLAN, "/repo");
    await vi.waitFor(() => expect(h.prompts.map((prompt) => taskOf(prompt.message))).toContain("T2"));
    await h.runs.whenIdle(PLAN);
    expect(h.closed).toEqual(["chat2"]);
    h.viewing.delete("chat1");
    h.host.detach("chat1", "w");
    expect(h.closed).toEqual(["chat2", "chat1"]);
  });
});

describe("orchestrator chats", () => {
  it("does not expose a default-model orchestrator when the configured model cannot be selected", async () => {
    h.tasks.useModel.mockRejectedValueOnce(new Error("model selection rejected"));
    await expect(h.runs.orchestrator(client, "/repo", PLAN)).rejects.toThrow("model selection rejected");
    expect(h.runs.state().orchestrators[PLAN]).toBeUndefined();
    expect(h.closed).toEqual(["chat1"]);
    await h.runs.orchestrator(client, "/repo", PLAN);
    expect(h.host.open).toHaveBeenCalledTimes(2);
  });

  it("does not hand a second client the chat before its model selection finishes", async () => {
    let finish!: () => void;
    h.tasks.useModel.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const first = h.runs.orchestrator(client, "/repo", PLAN);
    await vi.waitFor(() => expect(h.tasks.useModel).toHaveBeenCalledOnce());
    let joined = false;
    const second = h.runs.orchestrator({ clientId: "phone", actor: "d1" }, "/repo", PLAN).then((result) => { joined = true; return result; });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(h.runs.state().orchestrators[PLAN]).toBeUndefined();
    finish();
    expect((await second).handle).toBe((await first).handle);
  });

  it("starts one per plan on the orchestrator model, and joins it for a second client", async () => {
    const first = await h.runs.orchestrator(client, "/repo", PLAN);
    expect(h.host.open).toHaveBeenCalledWith({ cwd: "/repo", atp: { role: "orchestrator", plan: PLAN } }, { client });
    expect(h.tasks.useModel).toHaveBeenCalledOnce();
    const second = await h.runs.orchestrator({ clientId: "phone", actor: "d1" }, "/repo", PLAN);
    expect(second.handle).toBe(first.handle);
    expect(h.host.open).toHaveBeenCalledOnce();
    expect(h.attached.get(first.handle)).toEqual(new Set(["w", "phone"]));
    expect(h.runs.state().orchestrators[PLAN]).toBe(first.handle);
  });

  it("opens a plan's chat once when two clients ask at the same time", async () => {
    const [a, b] = await Promise.all([h.runs.orchestrator(client, "/repo", PLAN), h.runs.orchestrator({ clientId: "phone", actor: "d1" }, "/repo", PLAN)]);
    expect(a.handle).toBe(b.handle);
    expect(h.host.open).toHaveBeenCalledOnce();
    expect(h.attached.get(a.handle)).toEqual(new Set(["w", "phone"]));
  });

  it("resumes from the plan's session file, and keeps its own model", async () => {
    h.threads.get.mockResolvedValueOnce({ orchestrator: "/atp-sessions/old.jsonl", workers: {} } as never);
    await h.runs.orchestrator(client, "/repo", PLAN);
    expect(h.host.open).toHaveBeenCalledWith({ cwd: "/repo", sessionPath: "/atp-sessions/old.jsonl", atp: { role: "orchestrator", plan: PLAN } }, { client });
    expect(h.tasks.useModel).not.toHaveBeenCalled();
  });

  it("remembers the session file after its first run", async () => {
    const { handle } = await h.runs.orchestrator(client, "/repo", PLAN);
    h.settle(handle);
    await vi.waitFor(() => expect(h.threads.setOrchestrator).toHaveBeenCalledWith(PLAN, `/atp-sessions/${handle}.jsonl`));
    // A new plan's chat has no plan to keep it under yet.
    const fresh = await h.runs.orchestrator(client, "/repo", undefined);
    h.threads.setOrchestrator.mockClear();
    h.settle(fresh.handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.threads.setOrchestrator).not.toHaveBeenCalled();
    expect(h.runs.state().orchestrators["new:/repo"]).toBe(fresh.handle);
  });

  it("stops an idle orchestrator once the client leaves, a busy one once it finishes, and not one another client is in", async () => {
    const idle = await h.runs.orchestrator(client, "/repo", PLAN);
    const busy = await h.runs.orchestrator(client, "/repo", "/repo/other.atp.json");
    const shared = await h.runs.orchestrator(client, "/repo", "/repo/third.atp.json");
    h.host.attach(shared.handle, { clientId: "phone" });
    (h.chats.get(busy.handle) as FakeChat).running = true;
    h.runs.releaseOrchestrators(client);
    expect(h.closed).toEqual([idle.handle]);
    expect(h.runs.state().orchestrators).toEqual({ "/repo/other.atp.json": busy.handle, "/repo/third.atp.json": shared.handle });
    h.settle(busy.handle);
    await vi.waitFor(() => expect(h.closed).toEqual([idle.handle, busy.handle]));
    expect(h.runs.state().orchestrators).toEqual({ "/repo/third.atp.json": shared.handle });
  });

  it("does not stop a busy orchestrator the client came back to", async () => {
    const busy = await h.runs.orchestrator(client, "/repo", PLAN);
    (h.chats.get(busy.handle) as FakeChat).running = true;
    h.runs.releaseOrchestrators(client);
    await h.runs.orchestrator(client, "/repo", PLAN);
    h.settle(busy.handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.closed).toEqual([]);
  });

  it("the architect's chat becomes the orchestrator of the plan it wrote", async () => {
    const { handle } = await h.runs.orchestrator(client, "/repo", undefined);
    const chat = h.chats.get(handle) as FakeChat;
    const written = { path: "/repo/docs/plans/draft/new.atp.json", modifiedAt: 2000, plan: parsePlan("/repo/docs/plans/draft/new.atp.json", { nodes: {} }) };
    // Not prompted yet: it cannot have written anything.
    await h.runs.plansChanged({ cwd: "/repo", plans: [written] });
    expect(h.runs.state().orchestrators).toEqual({ "new:/repo": handle });
    chat.prompted = true;
    chat.items = [{ kind: "user", message: { timestamp: 1000 } }];
    await h.runs.plansChanged({ cwd: "/repo", plans: [{ ...written, path: "/repo/old.atp.json", modifiedAt: 10 }] });
    expect(h.runs.state().orchestrators).toEqual({ "new:/repo": handle });
    await h.runs.plansChanged({ cwd: "/repo", plans: [written] });
    expect(h.runs.state().orchestrators).toEqual({ [written.path]: handle });
    expect(h.threads.setOrchestrator).toHaveBeenCalledWith(written.path, `/atp-sessions/${handle}.jsonl`);
  });

  it("drops a new-plan chat so the next one starts fresh", async () => {
    const { handle } = await h.runs.orchestrator(client, "/repo", undefined);
    h.runs.discardNewPlan("/repo");
    expect(h.closed).toEqual([handle]);
    expect(h.runs.state().orchestrators).toEqual({});
    const next = await h.runs.orchestrator(client, "/repo", undefined);
    expect(next.handle).not.toBe(handle);
  });

  it("forgets an orchestrator whose pi exited", async () => {
    const { handle } = await h.runs.orchestrator(client, "/repo", PLAN);
    await h.host.close(handle);
    expect(h.runs.state().orchestrators).toEqual({});
  });
});

describe("plan threads", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pigna-threads-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps worker and orchestrator session files per plan on disk, and tells who listens", async () => {
    const file = join(dir, "atp-threads.json");
    const changes: [string, unknown][] = [];
    const threads = new AtpThreads(file, (plan, changed) => changes.push([plan, changed]));
    expect(await threads.get(PLAN)).toEqual({ workers: {} });
    await threads.remember(PLAN, "T1", "/s/a.jsonl");
    await threads.remember(PLAN, "T1", "/s/a.jsonl");
    await threads.remember(PLAN, "T1", "/s/b.jsonl");
    await threads.setOrchestrator(PLAN, "/s/o.jsonl");
    expect(changes).toHaveLength(3);
    const reopened = new AtpThreads(file);
    expect(await reopened.get(PLAN)).toEqual({ orchestrator: "/s/o.jsonl", workers: { T1: ["/s/a.jsonl", "/s/b.jsonl"] } });
  });

  it("merges the window's localStorage copy once: the host's own entries win, malformed ones are dropped", async () => {
    const file = join(dir, "atp-threads.json");
    const threads = new AtpThreads(file);
    await threads.remember(PLAN, "T1", "/s/b.jsonl");
    await threads.setOrchestrator(PLAN, "/s/host.jsonl");
    const legacy = {
      [PLAN]: { orchestrator: "/s/old.jsonl", workers: { T1: ["/s/a.jsonl", "/s/b.jsonl"], T2: ["/s/c.jsonl"], T3: ["not a path"] } },
      "/repo/other.atp.json": { orchestrator: "/s/oo.jsonl", workers: {} },
      "not-a-plan": { workers: {} },
    };
    await threads.importLegacy(legacy);
    expect(await threads.get(PLAN)).toEqual({ orchestrator: "/s/host.jsonl", workers: { T1: ["/s/b.jsonl", "/s/a.jsonl"], T2: ["/s/c.jsonl"] } });
    expect(await threads.get("/repo/other.atp.json")).toEqual({ orchestrator: "/s/oo.jsonl", workers: {} });
    expect(JSON.parse(await readFile(file, "utf8")).plans["not-a-plan"]).toBeUndefined();
    // A second hand-over (another launch of the window) changes nothing.
    await threads.importLegacy({ [PLAN]: { workers: { T9: ["/s/z.jsonl"] } } });
    expect((await threads.get(PLAN)).workers.T9).toBeUndefined();
    expect((await new AtpThreads(file).get(PLAN)).workers.T2).toEqual(["/s/c.jsonl"]);
  });

  it("starts empty from a missing or unreadable file", async () => {
    const file = join(dir, "atp-threads.json");
    await writeFile(file, "{");
    expect(await new AtpThreads(file).get(PLAN)).toEqual({ workers: {} });
  });
});
