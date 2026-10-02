// App state and actions. Session state transitions live in lib/session.ts (pure); this module
// owns side effects: IPC calls, toasts, lifecycle of pi processes, and project refreshes.
import type { HostEventBatch, ProjectGroup, SessionSummary } from "../../../shared/ipc";
import type {
  ExtensionUiResponse,
  ImageContent,
  Model,
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
} from "../../../shared/protocol";
import { createSession, hydrate, reduceHostEvent, type SessionState } from "../lib/session";
import { createStore, useStore } from "../lib/store";

export interface Toast {
  id: number;
  level: "info" | "warning" | "error";
  text: string;
}

export interface AppState {
  projects: ProjectGroup[];
  projectsLoaded: boolean;
  sessions: Record<string, SessionState>;
  /** Open handles in the order they were opened. */
  open: string[];
  active?: string;
  /** Ctrl+O: expand every activity group and tool row. */
  expandAll: boolean;
  /** Per-key overrides of the default expanded state. */
  expanded: Record<string, boolean>;
  toasts: Toast[];
  models: Model[];
  commands: Record<string, SlashCommand[]>;
  levels: Record<string, ThinkingLevel[]>;
}

export const store = createStore<AppState>({
  projects: [],
  projectsLoaded: false,
  sessions: {},
  open: [],
  expandAll: false,
  expanded: {},
  toasts: [],
  models: [],
  commands: {},
  levels: {},
});

export const useApp = <S>(selector: (state: AppState) => S): S => useStore(store, selector);

const studio = () => window.studio;

function patchSession(handle: string, update: (session: SessionState) => SessionState): void {
  store.set((state) => {
    const session = state.sessions[handle];
    if (!session) return state;
    const next = update(session);
    return next === session ? state : { ...state, sessions: { ...state.sessions, [handle]: next } };
  });
}

// ── Toasts ───────────────────────────────────────────────────────────────────

let toastSeq = 0;
export function toast(text: string, level: Toast["level"] = "info"): void {
  const id = ++toastSeq;
  store.set((state) => ({ ...state, toasts: [...state.toasts.slice(-4), { id, level, text }] }));
  setTimeout(() => dismissToast(id), level === "error" ? 9000 : 5000);
}

export function dismissToast(id: number): void {
  store.set((state) => ({ ...state, toasts: state.toasts.filter((t) => t.id !== id) }));
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function command<T = unknown>(handle: string, cmd: RpcCommand, quiet = false): Promise<RpcResponse<T>> {
  const response = await studio().command<T>(handle, cmd);
  if (!response.success && !quiet) toast(`${cmd.type}: ${response.error ?? "failed"}`, "error");
  return response;
}

// ── Projects ─────────────────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshProjects(delay = 0): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const projects = await studio().listSessions();
    store.set((state) => ({ ...state, projects, projectsLoaded: true }));
  }, delay);
}

// ── Session lifecycle ────────────────────────────────────────────────────────

/** A session file written this recently may still be open in another pi process. */
const RECENT_WRITE_MS = 3 * 60_000;

function newHandle(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function openSession(summary: SessionSummary): void {
  const existing = Object.values(store.get().sessions).find((s) => s.sessionPath === summary.path);
  if (existing) return activate(existing.handle);
  void start(summary.cwd, summary.path, summary.modifiedAt);
}

export function newSession(cwd: string): void {
  void start(cwd);
}

async function start(cwd: string, sessionPath?: string, modifiedAt?: number): Promise<void> {
  const handle = newHandle();
  const recent = modifiedAt !== undefined && Date.now() - modifiedAt < RECENT_WRITE_MS;
  const session = { ...createSession(handle, cwd, sessionPath), recentWriteAt: recent ? modifiedAt : undefined };
  store.set((state) => ({ ...state, sessions: { ...state.sessions, [handle]: session }, open: [...state.open, handle] }));
  activate(handle);
  try {
    const { entries } = await studio().openSession({ handle, cwd, sessionPath });
    if (entries.length) {
      // pi may already be ready (name, model) by the time the file is parsed; keep its live state.
      patchSession(handle, (s) => {
        const hydrated = hydrate(s, entries);
        return { ...hydrated, name: s.name ?? hydrated.name, thinkingLevel: s.thinkingLevel ?? hydrated.thinkingLevel };
      });
    }
  } catch (error) {
    toast(`Could not open session: ${(error as Error).message}`, "error");
    removeSession(handle);
  }
}

/** Sessions opened just to look at are closed again when you move on; prompted ones stay alive. */
function isDisposable(session: SessionState): boolean {
  return !session.prompted && !session.running && session.dialogs.length === 0;
}

export function activate(handle: string | undefined): void {
  const previous = store.get().active;
  if (previous === handle) return;
  store.set((state) => ({ ...state, active: handle }));
  const prev = previous ? store.get().sessions[previous] : undefined;
  if (prev && isDisposable(prev)) void closeSession(prev.handle, false);
}

export async function closeSession(handle: string, pickNext = true): Promise<void> {
  const { open, active } = store.get();
  if (pickNext && active === handle) {
    const index = open.indexOf(handle);
    const next = open[index + 1] ?? open[index - 1];
    store.set((state) => ({ ...state, active: next }));
  }
  removeSession(handle);
  await studio().closeSession(handle);
}

function removeSession(handle: string): void {
  store.set((state) => {
    const { [handle]: _removed, ...sessions } = state.sessions;
    return {
      ...state,
      sessions,
      open: state.open.filter((h) => h !== handle),
      active: state.active === handle ? undefined : state.active,
    };
  });
}

// ── Host events ──────────────────────────────────────────────────────────────

const seenStartupNotices = new Set<string>();

export function handleBatch(batch: HostEventBatch): void {
  const { handle, events } = batch;
  if (!store.get().sessions[handle]) return;
  patchSession(handle, (session) => events.reduce((s, event) => reduceHostEvent(s, event, Date.now()), session));

  for (const event of events) {
    if (event.kind === "ready") void onReady(handle, event.state);
    else if (event.kind === "exit") {
      if (event.code !== 0 && event.signal !== "SIGTERM") toast(`pi exited (${event.error ?? event.signal ?? `code ${event.code}`})`, "error");
    } else if (event.record.type === "extension_ui_request" && event.record.method === "notify") {
      const level = event.record.notifyType === "error" ? "error" : event.record.notifyType === "warning" ? "warning" : "info";
      // Every pi process repeats the same extension startup notices; show each one once per app run.
      const starting = store.get().sessions[handle]?.phase === "starting";
      if (starting && seenStartupNotices.has(event.record.message)) continue;
      if (starting) seenStartupNotices.add(event.record.message);
      toast(event.record.message, level);
    } else if (event.record.type === "agent_settled") void onSettled(handle);
  }
}

async function onReady(handle: string, state: RpcSessionState): Promise<void> {
  const [commands, levels, models] = await Promise.all([
    command<{ commands: SlashCommand[] }>(handle, { type: "get_commands" }, true),
    command<{ levels: ThinkingLevel[] }>(handle, { type: "get_available_thinking_levels" }, true),
    store.get().models.length ? undefined : command<{ models: Model[] }>(handle, { type: "get_available_models" }, true),
  ]);
  store.set((s) => ({
    ...s,
    commands: commands.data ? { ...s.commands, [handle]: commands.data.commands } : s.commands,
    levels: levels.data ? { ...s.levels, [handle]: levels.data.levels } : s.levels,
    models: models?.data?.models ?? s.models,
  }));
  if (state.messageCount > 0) void refreshStats(handle);
}

async function onSettled(handle: string): Promise<void> {
  const [state] = await Promise.all([command<RpcSessionState>(handle, { type: "get_state" }, true), refreshStats(handle)]);
  if (state.data) {
    const data = state.data;
    patchSession(handle, (s) => ({ ...s, sessionPath: data.sessionFile ?? s.sessionPath, name: data.sessionName ?? s.name, model: data.model ?? s.model }));
  }
  refreshProjects(300);
}

async function refreshStats(handle: string): Promise<void> {
  const stats = await command<SessionStats>(handle, { type: "get_session_stats" }, true);
  if (stats.data) {
    const data = stats.data;
    patchSession(handle, (s) => ({ ...s, stats: data }));
  }
}

// ── User actions ─────────────────────────────────────────────────────────────

export type SendMode = "send" | "followUp";

export async function send(handle: string, message: string, images: ImageContent[], mode: SendMode): Promise<boolean> {
  const session = store.get().sessions[handle];
  if (!session || session.phase === "exited") return false;
  const isCommand = message.startsWith("/");
  const cmd: RpcCommand = { type: "prompt", message, images: images.length ? images : undefined };
  if (session.running && !isCommand) cmd.streamingBehavior = mode === "followUp" ? "followUp" : "steer";
  patchSession(handle, (s) => ({ ...s, prompted: true }));
  const response = await command<{ disposition: string }>(handle, cmd);
  return response.success;
}

/** Esc: pull queued messages back into the composer, then abort the run. */
export async function interrupt(handle: string): Promise<string[]> {
  const session = store.get().sessions[handle];
  if (!session?.running) return [];
  let restored: string[] = [];
  if (session.queue.steering.length || session.queue.followUp.length) {
    const cleared = await command<{ steering: string[]; followUp: string[] }>(handle, { type: "clear_queue" }, true);
    restored = [...(cleared.data?.steering ?? []), ...(cleared.data?.followUp ?? [])];
  }
  await command(handle, { type: "abort" });
  return restored;
}

export async function setModel(handle: string, model: Model): Promise<void> {
  const response = await command<Model>(handle, { type: "set_model", provider: model.provider, modelId: model.id });
  if (!response.success) return;
  patchSession(handle, (s) => ({ ...s, model: response.data ?? model }));
  const levels = await command<{ levels: ThinkingLevel[] }>(handle, { type: "get_available_thinking_levels" }, true);
  const state = await command<RpcSessionState>(handle, { type: "get_state" }, true);
  store.set((s) => ({ ...s, levels: levels.data ? { ...s.levels, [handle]: levels.data.levels } : s.levels }));
  if (state.data) {
    const level = state.data.thinkingLevel;
    patchSession(handle, (s) => ({ ...s, thinkingLevel: level }));
  }
}

export async function setThinking(handle: string, level: ThinkingLevel): Promise<void> {
  const response = await command(handle, { type: "set_thinking_level", level });
  if (response.success) patchSession(handle, (s) => ({ ...s, thinkingLevel: level }));
}

export function respondDialog(handle: string, response: ExtensionUiResponse): void {
  patchSession(handle, (s) => ({ ...s, dialogs: s.dialogs.filter((d) => d.id !== response.id) }));
  studio().respondUi(handle, response);
}

export async function compact(handle: string): Promise<void> {
  await command(handle, { type: "compact" });
}

export function toggleExpandAll(): void {
  store.set((state) => ({ ...state, expandAll: !state.expandAll, expanded: {} }));
}

export function dismissRecentWrite(handle: string): void {
  patchSession(handle, (s) => ({ ...s, recentWriteAt: undefined }));
}

export function setExpanded(key: string, open: boolean): void {
  store.set((state) => ({ ...state, expanded: { ...state.expanded, [key]: open } }));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let booted = false;
export function boot(): void {
  if (booted) return;
  booted = true;
  studio().onEvents(handleBatch);
  refreshProjects();
  newSession(studio().launchCwd || studio().homeDir);
}

/** Name, else first user message, else "New session". */
export function sessionTitle(session: SessionState): string {
  if (session.name) return session.name;
  const first = session.items.find((item) => item.kind === "user");
  if (first?.kind === "user") {
    const content = first.message.content;
    const text = typeof content === "string" ? content : (content.find((block) => block.type === "text") as { text?: string } | undefined)?.text;
    if (text?.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return "New session";
}
