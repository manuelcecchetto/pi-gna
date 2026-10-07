// The ATP page's state: a view of what the host knows. Main finds the plans and runs them (src/main/atp-runner.ts):
// claiming nodes, starting the worker chats, committing, the orchestrator chats and the plans' threads. A plan keeps
// running with this window closed; the page shows it, starts and stops it. ATP chats never show in the sidebar:
// the page opens them.
import type { AtpProjectPlans, AtpSession } from "../../../shared/atp";
import type { AtpPlanThreads, AtpRunNote, AtpRunner, AtpRunnerState } from "../../../shared/host-api";
import { createStore, useStore } from "../lib/store";
import { useEffect } from "react";
import { adopt, remoteError, startAtpChat, store as app, toast } from "./app";

export type Runner = AtpRunner;
export type RunNote = AtpRunNote;
export type PlanThreads = AtpPlanThreads;

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

let booted = false;
const studio = () => window.studio;

/** The first use starts listening: the sidebar shows running plans from launch, the page everything else. */
export function useAtp<S>(selector: (state: AtpState) => S): S {
  useEffect(boot, []);
  return useStore(atpStore, selector);
}

// ── Threads: which chats worked on what, kept by the host ─────────────────────────────────────────────────────

const threads = createStore<Record<string, PlanThreads>>({});

/** A plan's threads; they load when first asked for and follow the host after that. */
export function useThreads(plan: string | undefined): PlanThreads | undefined {
  useEffect(() => {
    boot();
    if (plan && !threads.get()[plan]) void studio().atp.threads(plan).then((loaded) => threads.set((state) => ({ ...state, [plan]: state[plan] ?? loaded })), () => undefined);
  }, [plan]);
  return useStore(threads, (state) => (plan ? state[plan] : undefined));
}

/** Before the host kept the threads, this window did (localStorage): hand them over once. */
const LEGACY_THREADS = "pigna:atp-threads";
function importLegacyThreads(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LEGACY_THREADS);
  } catch {
    return;
  }
  if (saved === null) return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(saved);
  } catch {
    // unreadable: nothing to hand over
  }
  const forget = () => {
    try {
      localStorage.removeItem(LEGACY_THREADS);
    } catch {
      // storage unavailable
    }
  };
  if (parsed === null) return forget();
  void studio().atp.importThreads(parsed).then(forget, () => undefined);
}

// ── Plans, runs and orchestrators ────────────────────────────────────────────

function boot(): void {
  if (booted) return;
  booted = true;
  const atp = studio().atp;
  atp.onPlans((project) => {
    if (atpStore.get().project?.cwd === project.cwd) atpStore.set((s) => ({ ...s, project }));
  });
  atp.onHeld((held) => atpStore.set((s) => ({ ...s, held })));
  atp.onRunners(showRunners);
  atp.onThreads(({ plan, threads: changed }) => threads.set((state) => ({ ...state, [plan]: changed })));
  void atp.state().then(({ held, ...runs }) => {
    atpStore.set((s) => ({ ...s, held }));
    showRunners(runs);
  });
  importLegacyThreads();
}

function showRunners({ runners, notes, orchestrators }: AtpRunnerState): void {
  atpStore.set((s) => ({ ...s, runners, notes, orchestrators }));
  // The running worker's chat is the host's: join it, so the page can open it.
  for (const runner of Object.values(runners)) if (runner.handle) void adopt(runner.handle);
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

/** Run the plan in its project (activating it), or resume it: the host works through its nodes, window or not. */
export async function startPlan(plan: string, cwd: string): Promise<void> {
  boot();
  await call(() => studio().atp.start(plan, cwd));
}

/** Stop a plan's run: its worker is aborted and its node goes back to READY. Start resumes the plan. */
export const stopPlan = (plan: string): Promise<void> => call(() => studio().atp.stop(plan));

/** Give back a node pi-gna's worker still holds after a run that ended without it (a crash, a quit). */
export const releaseInterrupted = (plan: string, node: string): Promise<void> => call(() => studio().atp.releaseInterrupted(plan, node));

/** Let the runner claim nodes of a plan its orchestrator paused. */
export const liftHold = (plan: string): Promise<void> => call(() => studio().atp.liftHold(plan));

async function call(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    toast(remoteError(error), "error");
  }
}

// ── Chats ────────────────────────────────────────────────────────────────────

/** A chat of the plan (a node's worker, its orchestrator) from its session file, joined or started without showing it. */
export function threadHandle(cwd: string, path: string, title: string, atp: AtpSession): string {
  const live = Object.values(app.get().sessions).find((session) => session.sessionPath === path);
  return live ? live.handle : startAtpChat(cwd, atp, { path, title });
}

/**
 * The plan's orchestrator chat: the host starts it (or resumes it from its session file) when the page shows the
 * plan, and this window joins it. `plan` undefined: a chat for a new plan, which the architect skills write.
 */
export async function orchestrator(cwd: string, plan: string | undefined): Promise<string> {
  boot();
  const { handle } = await studio().atp.orchestrator(cwd, plan);
  await adopt(handle);
  return handle;
}

/** Drop a new-plan chat (New ATP again, or you cancelled it), so the next one starts fresh. */
export const discardNewPlanChat = (cwd: string): Promise<void> => call(() => studio().atp.discardNewPlan(cwd));

/** The page closed: the host stops the orchestrators that are idle (a pi process each); busy ones once they finish. */
export const releaseOrchestrators = (): Promise<void> => call(() => studio().atp.releaseOrchestrators());
