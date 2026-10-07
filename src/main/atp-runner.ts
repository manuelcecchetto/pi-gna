// pi-gna's ATP runner, in main so a plan keeps running with no window and any client can start, stop and watch it.
// It works like atp-runner: per plan, claim the next node (the librarian CLI, through Atp), start a fresh worker chat
// with the claim packet (workerMessage), wait for its run, check the node, commit what the worker left, repeat until
// nothing is READY. Workers complete, fail or decompose their node themselves; nothing here judges them. The runner
// also owns the plans' orchestrator chats (a client shows a plan: its orchestrator runs; nobody does: it stops) and
// the threads (which chats worked on what). A new plan's chat works in a git worktree of the project (Atp.newPlanCwd),
// and a plan's run and orchestrator work where the plan is: in that worktree, or in the project.
import { ATP_CONFIG, type AtpClaim, type AtpNode, type AtpPlan, type AtpProjectPlans, type AtpSession, nudgeMessage, workerMessage, workingNodes } from "../shared/atp";
import { checkoutOf } from "../shared/board";
import type { AtpRunNote, AtpRunner, AtpRunnerState, ClientPresence } from "../shared/host-api";
import type { RunOutcome } from "../shared/session-state";
import { type Settings, taskModel } from "../shared/settings";
import type { Atp } from "./atp";
import type { AtpThreads } from "./atp-threads";
import type { ChatTasks } from "./chat-tasks";
import { log } from "./log";
import type { SessionHost } from "./session-host";

export interface AtpRunnerDeps {
  host: Pick<SessionHost, "open" | "attach" | "detach" | "command" | "stateOf" | "presence" | "close" | "interrupt" | "identify" | "onSettled" | "onExit" | "onPresence">;
  tasks: Pick<ChatTasks, "launch" | "useModel">;
  atp: Pick<Atp, "activate" | "read" | "claim" | "release" | "head" | "commit" | "setHeld" | "newPlanCwd">;
  threads: Pick<AtpThreads, "get" | "remember" | "setOrchestrator">;
  settings: { get(): Promise<Settings> };
  /** The bundled librarian CLI, for the workers' prompts. */
  librarian: string;
  /** git and python3 need the login shell's environment. */
  shellEnv: Promise<void>;
  /** The runners, notes and orchestrators, whole, after every change. */
  publish(state: AtpRunnerState): void;
}

type Settled = RunOutcome | "exited";

/** The key of a project's orchestrator while its plan is not written yet. */
export const newPlanKey = (cwd: string): string => `new:${cwd}`;

export class AtpRuns {
  private readonly runners = new Map<string, AtpRunner>();
  private readonly notes = new Map<string, AtpRunNote>();
  /** Live orchestrator chats, by plan or `new:<project>`. */
  private readonly orchestrators = new Map<string, string>();
  private readonly opening = new Map<string, Promise<{ handle: string }>>();
  /** Orchestrator chats a client left while busy: they stop once idle, if nobody shows them by then. */
  private readonly releasing = new Set<string>();
  private readonly runs = new Map<string, Promise<void>>();
  /** Wakes a runner waiting for the orchestrator's pause to end, or for a stop. */
  private readonly wakers = new Map<string, () => void>();
  /** How many runs each chat has ended, and how the last one did; a chat's entry goes when its pi exits. */
  private readonly ends = new Map<string, { count: number; last: Settled }>();
  private readonly endWaiters = new Map<string, Set<() => void>>();
  /** Worker chats whose node is done, still open because a client is looking at them. */
  private readonly finished = new Set<string>();

  constructor(private readonly deps: AtpRunnerDeps) {
    const { host } = deps;
    host.onSettled((handle, outcome) => this.settled(handle, outcome));
    host.onExit((handle) => this.exited(handle));
    host.onPresence((handle) => this.presenceChanged(handle));
  }

  // ── State ──────────────────────────────────────────────────────────────────

  state(): AtpRunnerState {
    return { runners: Object.fromEntries(this.runners), notes: Object.fromEntries(this.notes), orchestrators: Object.fromEntries(this.orchestrators) };
  }

  private emit(): void {
    this.deps.publish(this.state());
  }

  private patch(plan: string, patch: Partial<AtpRunner>): void {
    const runner = this.runners.get(plan);
    if (!runner) return;
    this.runners.set(plan, { ...runner, ...patch });
    this.emit();
  }

  private note(plan: string, level: AtpRunNote["level"], text: string): void {
    this.notes.set(plan, { level, text, at: Date.now() });
    this.emit();
  }

  private running(plan: string): AtpRunner | undefined {
    const runner = this.runners.get(plan);
    return runner && runner.phase !== "stopping" ? runner : undefined;
  }

  /** Resolves when the plan's run has ended (tests; a plan that does not run: at once). */
  whenIdle(plan: string): Promise<void> {
    return this.runs.get(plan) ?? Promise.resolve();
  }

  /** The orchestrator paused or resumed a plan: a runner waiting for it looks again. */
  heldChanged(): void {
    for (const wake of this.wakers.values()) wake();
  }

  // ── The runner ─────────────────────────────────────────────────────────────

  /** Start (or resume) running a plan where it is (its project, or its worktree): activate it, then work through its nodes in the background. */
  start(plan: string, project: string): void {
    if (this.runners.has(plan)) return;
    const cwd = checkoutOf(plan, project);
    this.notes.delete(plan);
    this.runners.set(plan, { plan, cwd, phase: "starting", since: Date.now() });
    this.emit();
    const run = this.go(plan, cwd).finally(() => this.runs.delete(plan));
    this.runs.set(plan, run);
  }

  private async go(plan: string, cwd: string): Promise<void> {
    try {
      await this.deps.shellEnv;
      await this.deps.atp.activate(plan);
      await this.work(plan, cwd);
    } catch (error) {
      this.note(plan, "error", (error as Error).message);
    } finally {
      this.wakers.delete(plan);
      this.runners.delete(plan);
      this.emit();
    }
  }

  private async work(plan: string, cwd: string): Promise<void> {
    const { atp } = this.deps;
    for (;;) {
      if (!this.running(plan)) return;
      this.patch(plan, { phase: "claiming", node: undefined, title: undefined, handle: undefined });
      // A node our agent still holds was being worked on when an earlier run stopped: claim returns it first.
      const before = await atp.read(plan);
      const claim = await atp.claim(plan, ATP_CONFIG.agentId);
      if (!this.running(plan)) {
        if (claim.kind === "assigned") await this.release(plan, claim.node, "The user stopped the run before the node started.");
        return;
      }
      if (claim.kind === "held") {
        this.patch(plan, { phase: "held" });
        await new Promise<void>((resolve) => this.wakers.set(plan, resolve));
        this.wakers.delete(plan);
        continue;
      }
      if (claim.kind === "inactive") throw new Error(claim.message);
      if (claim.kind === "none") return this.finish(plan, claim.message, await atp.read(plan));
      const resumed = before.nodes.some((node) => node.id === claim.node && node.status === "CLAIMED" && node.worker === ATP_CONFIG.agentId);
      if (!(await this.runNode(plan, cwd, claim, resumed))) return;
    }
  }

  /** Nothing to claim: say why the run ends. */
  private finish(plan: string, message: string, after: AtpPlan): void {
    const left = after.nodes.filter((node) => !node.scope && !node.closed && node.status !== "COMPLETED");
    const failed = left.filter((node) => node.status === "FAILED");
    const working = workingNodes(after);
    if (!left.length) this.note(plan, "info", "Finished: every node is completed.");
    else if (failed.length) this.note(plan, "error", `Stopped: ${failed.map((node) => node.id).join(", ")} failed, and ${left.length - failed.length} node(s) wait behind ${failed.length === 1 ? "it" : "them"}.`);
    else if (working.length) this.note(plan, "info", `Nothing to claim while ${working.map((node) => `${node.id} (${node.worker ?? "?"})`).join(", ")} run elsewhere.`);
    else this.note(plan, "info", message);
  }

  /** One node in a fresh worker chat. False when the run should stop (stopped, or the worker left the node claimed). */
  private async runNode(plan: string, cwd: string, claim: Extract<AtpClaim, { kind: "assigned" }>, resumed: boolean): Promise<boolean> {
    const { atp, host, tasks } = this.deps;
    const head = await atp.head(cwd);
    const session: AtpSession = { role: "worker", plan, node: claim.node };
    const name = `ATP ${claim.node}: ${claim.title}`;
    const prompt = workerMessage({ project: cwd, plan, branch: head?.branch ?? "", librarian: this.deps.librarian, claim, resumed });
    this.patch(plan, { phase: "working", node: claim.node, title: claim.title, handle: undefined, since: Date.now() });
    const launched = await tasks.launch({ cwd, atp: session, name, prompt, model: taskModel(await this.deps.settings.get(), "worker") });
    this.patch(plan, { handle: launched.handle });
    const { handle } = launched;
    if (launched.failed) {
      await this.release(plan, claim.node, `The worker could not be started: ${launched.failed}`);
      this.note(plan, "error", `${claim.node}'s worker could not be started (${launched.failed}), so its claim was released.`);
      this.done(handle);
      return false;
    }
    // A stop during the start has no handle to abort yet: abort the chat now that there is one.
    if (!this.running(plan)) await this.abort(handle);

    let how = await this.endAfter(handle, 0);
    await this.remember(plan, claim.node, handle);
    let node = await this.nodeOf(plan, claim.node);
    if (this.running(plan) && stillClaimed(node) && how !== "exited") {
      this.patch(plan, { phase: "nudging" });
      const seen = this.ends.get(handle)?.count ?? 0;
      if ((await host.command(handle, { type: "prompt", message: nudgeMessage(claim.node) })).success) how = await this.endAfter(handle, seen);
      node = await this.nodeOf(plan, claim.node);
    }
    if (!this.running(plan)) {
      if (stillClaimed(node)) await this.release(plan, claim.node, "The user stopped the run in pi-gna.");
      this.done(handle);
      return false;
    }
    if (stillClaimed(node)) {
      await this.release(plan, claim.node, `The worker's run ended (${how}) without completing, failing or decomposing the node.`);
      this.note(plan, "error", `${claim.node}'s worker ended without finishing the node, so its claim was released. Open its chat (on the node) to see why, then run the plan again.`);
      this.done(handle);
      return false;
    }
    this.patch(plan, { phase: "committing" });
    if (ATP_CONFIG.commitPerNode) {
      try {
        const commit = await atp.commit(cwd, claim.node, claim.title, head);
        if (commit.kind === "committed") this.note(plan, "info", `Committed what ${claim.node}'s worker left (${commit.sha.slice(0, 8)}).`);
      } catch (error) {
        this.note(plan, "error", `Could not commit after ${claim.node}: ${(error as Error).message}`);
        this.done(handle);
        return false;
      }
    }
    this.done(handle);
    return true;
  }

  private async nodeOf(plan: string, id: string): Promise<AtpNode | undefined> {
    return (await this.deps.atp.read(plan)).nodes.find((node) => node.id === id);
  }

  /** The worker chat has done its part: close it, unless a client is looking at it (then once none is). */
  private done(handle: string): void {
    this.ends.delete(handle);
    const { host } = this.deps;
    if (!host.stateOf(handle)) return;
    if (host.presence(handle).some((client) => client.viewing)) this.finished.add(handle);
    else void host.close(handle, "host");
  }

  private presenceChanged(handle: string): void {
    if (!this.finished.has(handle) || this.deps.host.presence(handle).some((client) => client.viewing)) return;
    this.finished.delete(handle);
    void this.deps.host.close(handle, "host");
  }

  /** A run of the chat ended, or its pi exited. */
  private settled(handle: string, outcome: Settled): void {
    this.ends.set(handle, { count: (this.ends.get(handle)?.count ?? 0) + 1, last: outcome });
    for (const wake of [...(this.endWaiters.get(handle) ?? [])]) wake();
    if (outcome !== "exited") this.rememberOrchestrator(handle);
    // An orchestrator a client left while it worked stops now.
    if (this.releasing.has(handle)) this.dropIfIdle(handle);
  }

  private exited(handle: string): void {
    // A runner waiting for the chat reads the end from `ends` (and `done` clears it); no one waiting: nothing to keep.
    const waited = this.endWaiters.has(handle);
    this.settled(handle, "exited");
    if (!waited) this.ends.delete(handle);
    this.finished.delete(handle);
    this.releasing.delete(handle);
    for (const [key, owner] of this.orchestrators) {
      if (owner !== handle) continue;
      this.orchestrators.delete(key);
      this.emit();
    }
  }

  /** The next time the chat's run ends or its pi exits, after `seen` earlier ends. */
  private async endAfter(handle: string, seen: number): Promise<Settled> {
    for (;;) {
      const ended = this.ends.get(handle);
      if (ended && ended.count > seen) return ended.last;
      if (!this.deps.host.stateOf(handle)) return "exited";
      await new Promise<void>((resolve) => {
        const waiters = this.endWaiters.get(handle) ?? new Set();
        const wake = () => {
          waiters.delete(wake);
          if (!waiters.size) this.endWaiters.delete(handle);
          resolve();
        };
        waiters.add(wake);
        this.endWaiters.set(handle, waiters);
      });
    }
  }

  /** Keep the worker chat's session file with its node, for a client to open later. */
  private async remember(plan: string, node: string, handle: string): Promise<void> {
    const { host, threads } = this.deps;
    try {
      const path = host.stateOf(handle)?.sessionPath ?? (await host.identify(handle)).path;
      await threads.remember(plan, node, path);
    } catch (error) {
      log.warn("atp", `cannot keep ${node}'s worker chat with the node: ${(error as Error).message}`);
    }
  }

  private async release(plan: string, node: string, reason: string): Promise<void> {
    try {
      await this.deps.atp.release(plan, node, ATP_CONFIG.agentId, reason);
    } catch (error) {
      this.note(plan, "error", `Could not release ${node}: ${(error as Error).message}`);
    }
  }

  /** Abort the chat's run; one still starting has no run to abort yet, so its pi stops instead. */
  private async abort(handle: string): Promise<void> {
    const state = this.deps.host.stateOf(handle);
    if (!state) return;
    if (state.running || state.compacting) await this.deps.host.interrupt(handle);
    else void this.deps.host.close(handle, "host");
  }

  /** Stop a plan's run: abort its worker, whose node goes back to READY. Start resumes the plan. */
  async stop(plan: string): Promise<void> {
    const runner = this.runners.get(plan);
    if (!runner) return;
    this.patch(plan, { phase: "stopping" });
    this.wakers.get(plan)?.();
    if (runner.handle) await this.abort(runner.handle);
  }

  /** Give back a node pi-gna's worker still holds after a run that ended without it (a crash, a quit). */
  async releaseInterrupted(plan: string, node: string): Promise<void> {
    await this.deps.atp.release(plan, node, ATP_CONFIG.agentId, "The user released the claim of an interrupted run in pi-gna.");
  }

  /** Let the runner claim nodes of a plan its orchestrator paused. */
  liftHold(plan: string): void {
    this.deps.atp.setHeld(plan, false);
  }

  // ── Orchestrators ──────────────────────────────────────────────────────────

  /**
   * The plan's orchestrator chat for this client, started (or resumed from its session file) when it shows the plan.
   * `plan` undefined: a chat for a new plan, which the architect skills write, in a worktree of the project.
   */
  orchestrator(client: ClientPresence, cwd: string, plan: string | undefined): Promise<{ handle: string }> {
    const key = plan ?? newPlanKey(cwd);
    const live = this.orchestrators.get(key);
    if (live && this.deps.host.stateOf(live)) {
      this.releasing.delete(live);
      this.deps.host.attach(live, client);
      return Promise.resolve({ handle: live });
    }
    const pending = this.opening.get(key) ?? this.openOrchestrator(key, client, cwd, plan).finally(() => this.opening.delete(key));
    this.opening.set(key, pending);
    return pending.then(({ handle }) => {
      // A second client that asked while the first was opening it joins it.
      if (!this.deps.host.presence(handle).some((other) => other.clientId === client.clientId)) this.deps.host.attach(handle, client);
      return { handle };
    });
  }

  private async openOrchestrator(key: string, client: ClientPresence, cwd: string, plan: string | undefined): Promise<{ handle: string }> {
    const { host, tasks, threads, settings } = this.deps;
    await this.deps.shellEnv;
    const sessionPath = plan ? (await threads.get(plan)).orchestrator : undefined;
    const where = plan ? checkoutOf(plan, cwd) : await this.deps.atp.newPlanCwd(cwd);
    const { handle } = await host.open({ cwd: where, ...(sessionPath ? { sessionPath } : {}), atp: { role: "orchestrator", ...(plan ? { plan } : {}) } }, { client });
    if (!sessionPath) {
      // A new chat runs on the orchestrator model (Settings > Models); a resumed one keeps its own.
      try {
        const ready = await host.command(handle, { type: "get_state" });
        if (!ready.success) throw new Error(ready.error ?? "pi did not start");
        await tasks.useModel(handle, taskModel(await settings.get(), "orchestrator"));
      } catch (error) {
        await host.close(handle, "host");
        throw error;
      }
    }
    // Publish only after selection succeeds; another client must not prompt the default model during setup.
    this.orchestrators.set(key, handle);
    this.emit();
    return { handle };
  }

  /** A new plan appeared while its project's new-plan chat ran: that chat (the architect) becomes its orchestrator. */
  async plansChanged(project: AtpProjectPlans): Promise<void> {
    const { host, threads } = this.deps;
    const key = newPlanKey(project.cwd);
    const handle = this.orchestrators.get(key);
    const state = handle ? host.stateOf(handle) : undefined;
    if (!handle || !state?.prompted) return;
    const first = state.items[0];
    const since = first?.kind === "user" ? first.message.timestamp : 0;
    for (const file of project.plans) {
      if (!file.plan || this.orchestrators.has(file.path) || file.modifiedAt < since) continue;
      if ((await threads.get(file.path)).orchestrator) continue;
      if (this.orchestrators.get(key) !== handle) return;
      this.orchestrators.delete(key);
      this.orchestrators.set(file.path, handle);
      this.emit();
      const path = host.stateOf(handle)?.sessionPath;
      if (path) await threads.setOrchestrator(file.path, path);
      return;
    }
  }

  /** Drop a project's new-plan chat (New ATP again, or the user cancelled it), so the next one starts fresh. */
  discardNewPlan(cwd: string): void {
    const key = newPlanKey(cwd);
    const handle = this.orchestrators.get(key);
    if (!handle) return;
    this.orchestrators.delete(key);
    this.emit();
    if (this.deps.host.stateOf(handle)) void this.deps.host.close(handle, "host");
  }

  /** A client no longer shows the plans: the orchestrators nobody else is in stop (a pi process each); busy ones once they finish. */
  releaseOrchestrators(client: ClientPresence): void {
    for (const handle of [...this.orchestrators.values()]) {
      try {
        this.deps.host.detach(handle, client.clientId);
      } catch {
        // it ended meanwhile
      }
      this.dropIfIdle(handle);
    }
  }

  private dropIfIdle(handle: string): void {
    const { host } = this.deps;
    const state = host.stateOf(handle);
    if (!state || host.presence(handle).length) {
      this.releasing.delete(handle);
      return;
    }
    if (state.running || state.compacting || state.dialogs.length) {
      this.releasing.add(handle);
      return;
    }
    this.releasing.delete(handle);
    void host.close(handle, "host");
  }

  /** Remember an orchestrator's session file once it has one worth resuming: after its first run. */
  private rememberOrchestrator(handle: string): void {
    const key = [...this.orchestrators].find(([, owner]) => owner === handle)?.[0];
    const path = this.deps.host.stateOf(handle)?.sessionPath;
    if (key && !key.startsWith("new:") && path) void this.deps.threads.setOrchestrator(key, path).catch((error: Error) => log.warn("atp", `cannot keep the orchestrator's chat: ${error.message}`));
  }
}

const stillClaimed = (node: AtpNode | undefined) => node?.status === "CLAIMED" && !node.scope;
