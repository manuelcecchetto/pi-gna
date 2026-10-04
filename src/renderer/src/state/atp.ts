// The ATP page's state and pi-gna's ATP runner. The runner works like atp-runner: per plan, claim the next node
// (main runs the librarian CLI), start a fresh worker chat with the claim packet (workerMessage), wait for its run,
// check the node, commit what the worker left, repeat until nothing is READY. Workers complete, fail or decompose
// their node themselves; nothing here judges them. ATP chats never show in the sidebar: the page opens them.
import { ATP_CONFIG, type AtpClaim, type AtpNode, type AtpProjectPlans, type AtpSession, planName, workerMessage, workingNodes, nudgeMessage } from "../../../shared/atp";
import { createStore, useStore } from "../lib/store";
import { activate, closeSession, command, interrupt, onSettle, remoteError, type Settled, startAtpChat, store as app, toast } from "./app";

/** One plan's run, while pi-gna runs it. */
export interface Runner {
  plan: string;
  /** The project the workers work in. */
  cwd: string;
  phase: "starting" | "claiming" | "working" | "nudging" | "committing" | "held" | "stopping";
  node?: string;
  title?: string;
  /** The current node's worker chat. */
  handle?: string;
  since: number;
}

/** Why a plan's run stopped by itself, or what it did last; until the plan starts again. */
export interface RunNote {
  level: "info" | "error";
  text: string;
  at: number;
}

export interface AtpState {
  /** The ATP page's project and its plans, as main pushes them. */
  project?: AtpProjectPlans;
  /** Plans an orchestrator paused (atp_pause). */
  held: string[];
  runners: Record<string, Runner>;
  notes: Record<string, RunNote>;
  /** Live orchestrator chats: by plan, or `new:<project>` for a plan the architect is still writing. */
  orchestrators: Record<string, string>;
}

export const atpStore = createStore<AtpState>({ held: [], runners: {}, notes: {}, orchestrators: {} });
export const useAtp = <S>(selector: (state: AtpState) => S): S => useStore(atpStore, selector);

const studio = () => window.studio;
const newPlanKey = (cwd: string) => `new:${cwd}`;

// ── Threads: which chats worked on what, kept in localStorage like the sidebar's pins ─────────────────────────

interface PlanThreads {
  orchestrator?: string;
  /** Node -> its worker chats' session files, oldest first (a node runs again after a stop). */
  workers: Record<string, string[]>;
}

const THREADS = "pigna:atp-threads";

function loadThreads(): Record<string, PlanThreads> {
  try {
    const saved = JSON.parse(localStorage.getItem(THREADS) ?? "null") as unknown;
    return saved && typeof saved === "object" ? (saved as Record<string, PlanThreads>) : {};
  } catch {
    return {};
  }
}

const threads = createStore<Record<string, PlanThreads>>(loadThreads());
export const useThreads = (plan: string | undefined): PlanThreads | undefined => useStore(threads, (state) => (plan ? state[plan] : undefined));

function saveThreads(key: string, update: (entry: PlanThreads) => PlanThreads): void {
  threads.set((state) => ({ ...state, [key]: update(state[key] ?? { workers: {} }) }));
  try {
    localStorage.setItem(THREADS, JSON.stringify(threads.get()));
  } catch {
    // storage unavailable: the page forgets the threads when pi-gna quits
  }
}

// ── Plans ────────────────────────────────────────────────────────────────────

let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;
  studio().atp.onPlans((project) => {
    if (atpStore.get().project?.cwd !== project.cwd) return;
    atpStore.set((s) => ({ ...s, project }));
    adoptNewPlans(project);
  });
  studio().atp.onHeld((held) => {
    atpStore.set((s) => ({ ...s, held }));
    for (const wake of wakers.values()) wake();
  });
  void studio()
    .atp.held()
    .then((held) => atpStore.set((s) => ({ ...s, held })));
  // Worker chats you were looking at when their node finished close once you look elsewhere.
  app.subscribe(() => {
    if (!finished.size) return;
    const { active, page } = app.get();
    for (const handle of finished) {
      if (handle === active && !page) continue;
      finished.delete(handle);
      if (app.get().sessions[handle]) void closeSession(handle, false);
    }
  });
}

/** Show a project's plans on the page (and watch them); null when the page closes. */
export async function watchProject(cwd: string | null): Promise<void> {
  boot();
  if (cwd === null) {
    atpStore.set((s) => ({ ...s, project: undefined }));
    void studio().atp.watch(null);
    return;
  }
  atpStore.set((s) => (s.project?.cwd === cwd ? s : { ...s, project: { cwd, plans: [] } }));
  try {
    const project = await studio().atp.watch(cwd);
    if (project && atpStore.get().project?.cwd === cwd) atpStore.set((s) => ({ ...s, project }));
  } catch (error) {
    toast(`Could not read the ATP plans: ${remoteError(error)}`, "error");
  }
}

// ── The runner ───────────────────────────────────────────────────────────────

let librarian: Promise<string> | undefined;
/** Wakes a runner waiting for the orchestrator's pause to end, or for a stop. */
const wakers = new Map<string, () => void>();
/** Worker chats whose node is done, still open because you were looking at them. */
const finished = new Set<string>();

function patchRunner(plan: string, patch: Partial<Runner>): void {
  atpStore.set((s) => {
    const runner = s.runners[plan];
    return runner ? { ...s, runners: { ...s.runners, [plan]: { ...runner, ...patch } } } : s;
  });
}

function note(plan: string, level: RunNote["level"], text: string): void {
  atpStore.set((s) => ({ ...s, notes: { ...s.notes, [plan]: { level, text, at: Date.now() } } }));
}

const running = (plan: string) => {
  const runner = atpStore.get().runners[plan];
  return runner && runner.phase !== "stopping" ? runner : undefined;
};

/** Start (or resume) running a plan in its project: activate it, then work through its nodes. */
export async function startPlan(plan: string, cwd: string): Promise<void> {
  boot();
  if (atpStore.get().runners[plan]) return;
  atpStore.set((s) => {
    const { [plan]: _note, ...notes } = s.notes;
    return { ...s, notes, runners: { ...s.runners, [plan]: { plan, cwd, phase: "starting", since: Date.now() } } };
  });
  try {
    librarian ??= studio()
      .atp.info()
      .then((info) => info.librarian);
    await studio().atp.activate(plan);
    await work(plan, cwd, await librarian);
  } catch (error) {
    note(plan, "error", remoteError(error));
  } finally {
    wakers.delete(plan);
    atpStore.set((s) => {
      const { [plan]: _runner, ...runners } = s.runners;
      return { ...s, runners };
    });
  }
}

async function work(plan: string, cwd: string, cli: string): Promise<void> {
  for (;;) {
    if (!running(plan)) return;
    patchRunner(plan, { phase: "claiming", node: undefined, title: undefined, handle: undefined });
    // A node our agent still holds was being worked on when an earlier run stopped: claim returns it first.
    const before = await studio().atp.read(plan);
    const claim = await studio().atp.claim(plan, ATP_CONFIG.agentId);
    if (!running(plan)) {
      if (claim.kind === "assigned") await release(plan, claim.node, "The user stopped the run before the node started.");
      return;
    }
    if (claim.kind === "held") {
      patchRunner(plan, { phase: "held" });
      await new Promise<void>((resolve) => wakers.set(plan, resolve));
      wakers.delete(plan);
      continue;
    }
    if (claim.kind === "inactive") throw new Error(claim.message);
    if (claim.kind === "none") {
      const after = await studio().atp.read(plan);
      const left = after.nodes.filter((node) => !node.scope && !node.closed && node.status !== "COMPLETED");
      const failed = left.filter((node) => node.status === "FAILED");
      if (!left.length) note(plan, "info", "Finished: every node is completed.");
      else if (failed.length) note(plan, "error", `Stopped: ${failed.map((node) => node.id).join(", ")} failed, and ${left.length - failed.length} node(s) wait behind ${failed.length === 1 ? "it" : "them"}.`);
      else if (workingNodes(after).length) note(plan, "info", `Nothing to claim while ${workingNodes(after).map((node) => `${node.id} (${node.worker ?? "?"})`).join(", ")} run elsewhere.`);
      else note(plan, "info", claim.message);
      return;
    }
    const resumed = before.nodes.some((node) => node.id === claim.node && node.status === "CLAIMED" && node.worker === ATP_CONFIG.agentId);
    if (!(await runNode(plan, cwd, cli, claim, resumed))) return;
  }
}

/** One node in a fresh worker chat. False when the run should stop (stopped, or the worker left the node claimed). */
async function runNode(plan: string, cwd: string, cli: string, claim: Extract<AtpClaim, { kind: "assigned" }>, resumed: boolean): Promise<boolean> {
  const head = await studio().atp.head(cwd);
  const atp: AtpSession = { role: "worker", plan, node: claim.node };
  const name = `ATP ${claim.node}: ${claim.title}`;
  const message = workerMessage({ project: cwd, plan, branch: head?.branch ?? "", librarian: cli, claim, resumed });
  const handle = startAtpChat(cwd, atp, { setup: { name, model: ATP_CONFIG.worker, prompt: message } });
  patchRunner(plan, { phase: "working", node: claim.node, title: claim.title, handle, since: Date.now() });

  let how = await settledOnce(handle);
  remember(plan, claim.node, handle);
  let node = await nodeOf(plan, claim.node);
  if (running(plan) && stillClaimed(node) && how !== "exited") {
    patchRunner(plan, { phase: "nudging" });
    const next = settledOnce(handle);
    if ((await command(handle, { type: "prompt", message: nudgeMessage(claim.node) })).success) how = await next;
    node = await nodeOf(plan, claim.node);
  }
  if (!running(plan)) {
    if (stillClaimed(node)) await release(plan, claim.node, "The user stopped the run in pi-gna.");
    done(handle);
    return false;
  }
  if (stillClaimed(node)) {
    await release(plan, claim.node, `The worker's run ended (${how}) without completing, failing or decomposing the node.`);
    note(plan, "error", `${claim.node}'s worker ended without finishing the node, so its claim was released. Open its chat (on the node) to see why, then run the plan again.`);
    done(handle);
    return false;
  }
  patchRunner(plan, { phase: "committing" });
  if (ATP_CONFIG.commitPerNode) {
    try {
      const commit = await studio().atp.commit(cwd, claim.node, claim.title, head);
      if (commit.kind === "committed") note(plan, "info", `Committed what ${claim.node}'s worker left (${commit.sha.slice(0, 8)}).`);
    } catch (error) {
      note(plan, "error", `Could not commit after ${claim.node}: ${remoteError(error)}`);
      done(handle);
      return false;
    }
  }
  done(handle);
  return true;
}

/** The node's worker chat has done its part: close it, unless you are looking at it (then once you are not). */
function done(handle: string): void {
  const { active, page } = app.get();
  if (handle === active && !page) finished.add(handle);
  else if (app.get().sessions[handle]) void closeSession(handle, false);
}

const stillClaimed = (node: AtpNode | undefined) => node?.status === "CLAIMED" && !node.scope;

async function nodeOf(plan: string, id: string): Promise<AtpNode | undefined> {
  return (await studio().atp.read(plan)).nodes.find((node) => node.id === id);
}

/** The next time the chat's run ends or its pi exits. */
function settledOnce(handle: string): Promise<Settled> {
  if (!app.get().sessions[handle]) return Promise.resolve("exited");
  return new Promise((resolve) => {
    const off = onSettle(handle, (how) => {
      off();
      resolve(how);
    });
  });
}

/** Keep the worker chat's session file with its node, for the page to open later. */
function remember(plan: string, node: string, handle: string): void {
  const path = app.get().sessions[handle]?.sessionPath;
  if (!path) return;
  saveThreads(plan, (entry) => {
    const paths = entry.workers[node] ?? [];
    return paths.includes(path) ? entry : { ...entry, workers: { ...entry.workers, [node]: [...paths, path] } };
  });
}

async function release(plan: string, node: string, reason: string): Promise<void> {
  try {
    await studio().atp.release(plan, node, ATP_CONFIG.agentId, reason);
  } catch (error) {
    toast(`Could not release ${node}: ${remoteError(error)}`, "error");
  }
}

/** Stop a plan's run: abort its worker, whose node goes back to READY. Start resumes the plan. */
export async function stopPlan(plan: string): Promise<void> {
  const runner = atpStore.get().runners[plan];
  if (!runner) return;
  patchRunner(plan, { phase: "stopping" });
  wakers.get(plan)?.();
  const session = runner.handle && app.get().sessions[runner.handle];
  if (!session) return;
  // A worker still starting has no run to abort yet: stop its pi instead.
  if (session.running || session.compacting) await interrupt(session.handle);
  else void closeSession(session.handle, false);
}

/** Give back a node pi-gna's worker still holds after a run that ended without it (a crash, a quit). */
export async function releaseInterrupted(plan: string, node: string): Promise<void> {
  await release(plan, node, "The user released the claim of an interrupted run in pi-gna.");
}

/** Let the runner claim nodes of a plan its orchestrator paused. */
export async function liftHold(plan: string): Promise<void> {
  try {
    await studio().atp.setHeld(plan, false);
  } catch (error) {
    toast(remoteError(error), "error");
  }
}

// ── Chats ────────────────────────────────────────────────────────────────────

/** Open a chat of the plan (a node's worker, its orchestrator) from its session file, as the active chat. */
export function openThread(cwd: string, path: string, title: string, atp: AtpSession): void {
  const live = Object.values(app.get().sessions).find((session) => session.sessionPath === path);
  if (live) return activate(live.handle);
  activate(startAtpChat(cwd, atp, { resume: { path, title } }));
}

/**
 * The plan's orchestrator chat, started (or resumed from its session file) when the page shows the plan. `plan`
 * undefined: a chat for a new plan, which the architect skills write.
 */
export function orchestrator(cwd: string, plan: string | undefined): string {
  boot();
  const key = plan ?? newPlanKey(cwd);
  const live = atpStore.get().orchestrators[key];
  if (live && app.get().sessions[live]) return live;
  const path = plan ? threads.get()[plan]?.orchestrator : undefined;
  const atp: AtpSession = { role: "orchestrator", plan };
  const handle = path
    ? startAtpChat(cwd, atp, { resume: { path, title: `${planName(plan as string)} orchestrator` } })
    : startAtpChat(cwd, atp, { setup: { model: ATP_CONFIG.orchestrator } });
  atpStore.set((s) => ({ ...s, orchestrators: { ...s.orchestrators, [key]: handle } }));
  // Remembered once it has a session file worth resuming: after its first run.
  const off = onSettle(handle, (how) => {
    if (how === "exited") return off();
    const sessionPath = app.get().sessions[handle]?.sessionPath;
    const owner = Object.entries(atpStore.get().orchestrators).find(([, other]) => other === handle)?.[0];
    if (sessionPath && owner && !owner.startsWith("new:")) saveThreads(owner, (entry) => ({ ...entry, orchestrator: sessionPath }));
  });
  return handle;
}

/** A new plan appeared while its project's new-plan chat ran: that chat (the architect) becomes its orchestrator. */
function adoptNewPlans(project: AtpProjectPlans): void {
  const key = newPlanKey(project.cwd);
  const handle = atpStore.get().orchestrators[key];
  const session = handle ? app.get().sessions[handle] : undefined;
  if (!handle || !session?.prompted) return;
  const known = new Set(Object.keys(atpStore.get().orchestrators));
  const adopted = project.plans.find((file) => file.plan && !known.has(file.path) && !threads.get()[file.path]?.orchestrator && file.modifiedAt >= (session.items[0]?.kind === "user" ? session.items[0].message.timestamp : 0));
  if (!adopted) return;
  atpStore.set((s) => {
    const { [key]: _new, ...rest } = s.orchestrators;
    return { ...s, orchestrators: { ...rest, [adopted.path]: handle } };
  });
  if (session.sessionPath) saveThreads(adopted.path, (entry) => ({ ...entry, orchestrator: session.sessionPath }));
}

/** Drop a new-plan chat (New ATP again, or you cancelled it), so the next one starts fresh. */
export function discardNewPlanChat(cwd: string): void {
  const key = newPlanKey(cwd);
  const handle = atpStore.get().orchestrators[key];
  atpStore.set((s) => {
    const { [key]: _gone, ...orchestrators } = s.orchestrators;
    return { ...s, orchestrators };
  });
  if (handle && app.get().sessions[handle]) void closeSession(handle, false);
}

/** The page closed: stop the orchestrators that are idle (a pi process each); busy ones once they finish. */
export function releaseOrchestrators(): void {
  for (const [key, handle] of Object.entries(atpStore.get().orchestrators)) {
    const session = app.get().sessions[handle];
    const drop = () => {
      if (app.get().page?.kind === "atp" || app.get().active === handle) return;
      atpStore.set((s) => {
        if (s.orchestrators[key] !== handle) return s;
        const { [key]: _gone, ...orchestrators } = s.orchestrators;
        return { ...s, orchestrators };
      });
      if (app.get().sessions[handle]) void closeSession(handle, false);
    };
    if (!session) drop();
    else if (session.running || session.compacting || session.dialogs.length) {
      const off = onSettle(handle, () => {
        off();
        drop();
      });
    } else drop();
  }
}
