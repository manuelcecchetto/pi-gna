// App state and actions. Session state transitions live in shared/session-state.ts (pure); this module
// owns side effects: IPC calls, toasts, lifecycle of pi processes, and project refreshes.
import type { AtpSession } from "../../../shared/atp";
import { applyOp, type Board, BoardError, type BoardOp, type Card, type Column, emptyBoard, freshId, LIMITS, projectOf } from "../../../shared/board";
import { formatAnnotations } from "../../../shared/annotations";
import type { Annotation, BrowserState } from "../../../shared/browser";
import type { GithubItem, GithubRepo } from "../../../shared/github";
import { applyLamentOp, emptyLaments, type Lament, LamentError, type LamentOp, type Laments } from "../../../shared/laments";
import { emptyThemes, type ThemeOp, type Themes } from "../../../shared/themes";
import type { Look } from "../lib/theme";
import {
  applySettingsOp,
  emptySettings,
  type Feature,
  FEATURE_LABELS,
  type Settings,
  type SettingsOp,
  type SettingsSection,
  type TaskModel,
  taskModel,
} from "../../../shared/settings";
import type { AttentionSummary, ChatSnapshot, Revved, TaskTarget } from "../../../shared/host-api";
import type { CardWorktree, HostEventBatch, OpenSessionResult, Page, ProjectGroup, SessionSummary, UpdateState } from "../../../shared/ipc";
import { patchProjects } from "../../../shared/session-list";
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
import {
  type Attachment,
  attachmentImages,
  formatFileMentions,
  fromImageData,
  fromPicked,
  mergeAttachments,
  stripStudioBlocks,
} from "../lib/attachments";
import type { CompactionSettings } from "../../../shared/compaction";
import { cardBlock, inChatPrompt, pickModel } from "../../../shared/task-prompts";
import { applyUi, bootUiState, uiStore } from "../lib/host-ui";
import { loadSidebar, type SidebarLayout, saveSidebar } from "../lib/layout";
import { lightboxAt, lightboxStep, type LightboxView } from "../lib/lightbox";
import { applyQueueOp, type QueueOp, type Queues } from "../../../shared/queue";
import { attention, createSession, isDisposable, isDraft, isListed, reduceHostEvent, type RunOutcome, runOutcome, type SessionState } from "../../../shared/session-state";
import type { TurnOutline } from "../../../shared/turn-outline";
import type { EarlierTurns } from "../components/Transcript";
import type { OpenChat } from "../lib/projects";
import { pagePreview } from "../lib/rail";
import { createStore, shallow, useStore, useStoreShallow } from "../lib/store";

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
  /** The browser of the chat on screen: the tabs it owns (main keeps every chat's tabs, see `browserAll`). */
  browser: BrowserState;
  /** Every chat's browser tabs as main reports them. */
  browserAll: BrowserState;
  /** The pane of the chat on screen; each chat has its own (`panes`), the split is shared. */
  pane: { open: boolean; full: boolean; /** Browser share of the main area, 0..1. */ split: number };
  /** The pane of the chats that are not on screen (open, full), restored when they come back. */
  panes: Record<string, { open: boolean; full: boolean }>;
  /** Browser comments per session handle, waiting to ride along with that chat's next prompt. */
  annotations: Record<string, Annotation[]>;
  /** Composer attachments per session handle (picker, drag and drop, paste). */
  attachments: Record<string, Attachment[]>;
  /** The card in a chat's composer, per session handle ("Chat about it"): it goes with the chat's first message. */
  composerCards: Record<string, string>;
  /** Card tasks (Investigate, Resolve, QA) the host is starting or just started, per card id (startCardTask). */
  cardTasks: Record<string, CardTasks>;
  /** Other task chats the host is starting or just started (a lament's Fix, a pull request's Review), by taskKey. */
  taskStarts: Record<string, CardTaskPhase>;
  sidebar: SidebarLayout;
  /** pi's compaction settings, for the context meter's auto-compaction point. */
  compaction: CompactionSettings;
  /** Full-size image overlay (data URLs) and the images it pages through. Hides the native browser view while open. */
  lightbox?: LightboxView;
  /** Every project's Kanban cards. Main owns them (agents change them too) and pushes each change. */
  board: Revved<Board>;
  /** Every project's laments, which agents file; main owns them and pushes each change. */
  laments: Revved<Laments>;
  /** Custom themes (global and per project); main owns them and pushes each change. */
  themes: Revved<Themes>;
  /** The images and wallpaper of the theme on screen (ThemeRoot), for the empty state. */
  look?: Look;
  /** pi-gna's own settings (features, appearance, task models); main owns them and pushes each change. */
  settings: Revved<Settings>;
  /** A full-window page shown instead of the active chat. */
  page?: PageState;
  /** A DOM dialog or menu is open over the page; it hides the native browser view, which would cover it. */
  overlay: boolean;
  /** A newer pi-gna release and how far installing it got (main's Updater). */
  update: UpdateState;
  /** The update dialog is open. */
  updateOpen: boolean;
  /** The ⌘K search is open. */
  palette: boolean;
}

/** A page of one project (its Kanban board, maybe with a card open, its laments, ...), or the Settings page. */
export interface PageState {
  kind: Page;
  cwd: string;
  card?: string;
  /** Settings: the section shown. */
  section?: SettingsSection;
  /** Settings: the page it was opened from, which "Back to app" returns to. */
  back?: PageState;
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
  browser: { tabs: [], annotating: false },
  browserAll: { tabs: [], annotating: false },
  pane: { open: false, full: false, split: 0.5 },
  panes: {},
  annotations: {},
  attachments: {},
  composerCards: {},
  cardTasks: {},
  taskStarts: {},
  compaction: {},
  sidebar: loadSidebar(),
  board: { ...emptyBoard(), rev: 0 },
  laments: { ...emptyLaments(), rev: 0 },
  themes: { ...emptyThemes(), rev: 0 },
  settings: { ...emptySettings(), rev: 0 },
  overlay: false,
  update: { phase: "idle" },
  updateOpen: false,
  palette: false,
});

export const useApp = <S>(selector: (state: AppState) => S): S => useStore(store, selector);
/** useApp for a selector that builds a new array or object (lib/store.ts useStoreShallow). */
export const useAppShallow = <S>(selector: (state: AppState) => S): S => useStoreShallow(store, selector);

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

/** An error from main without Electron's "Error invoking remote method '…': Error: " in front. */
export const remoteError = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");

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

/** A settled run's session file, re-indexed by the host: patch its row. Before the first listing there is nothing to patch. */
function onSessionIndexed(path: string, summary: SessionSummary | null): void {
  store.set((state) => {
    const projects = state.projectsLoaded ? patchProjects(state.projects, path, summary) : state.projects;
    return projects === state.projects ? state : { ...state, projects };
  });
}

// ── Session lifecycle ────────────────────────────────────────────────────────

function newHandle(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function openSession(summary: SessionSummary): void {
  const existing = Object.values(store.get().sessions).find((s) => s.sessionPath === summary.path);
  if (existing) return activate(existing.handle);
  start(summary.cwd, summary);
}

export function newSession(cwd: string): void {
  // Starting a chat in a hidden project shows it again.
  if (uiStore.get().hidden.includes(projectOf(cwd))) applyUi({ type: "unhide", cwd: projectOf(cwd) });
  const { active, sessions } = store.get();
  const current = active ? sessions[active] : undefined;
  if (current && current.cwd === cwd && current.phase !== "exited" && isDraft(current)) {
    activate(current.handle); // leaves a page
    prefill(current.handle, ""); // already in an empty chat here: just focus its composer
    removeComposerCard(current.handle); // a new chat is about no card
    return;
  }
  start(cwd);
}

/** Start pi for a new chat or a session file; background chats (from a card, ATP's) are not shown. */
function start(cwd: string, summary?: Pick<SessionSummary, "path" | "title">, show = true, atp?: AtpSession): string {
  const handle = newHandle();
  const sessionPath = summary?.path;
  // It is shown right away, so it must not look like an empty new chat until its history arrives.
  const session: SessionState = { ...createSession(handle, cwd, sessionPath, atp), loading: summary && { title: summary.title } };
  store.set((state) => ({ ...state, sessions: { ...state.sessions, [handle]: session }, open: [...state.open, handle] }));
  if (show) activate(handle);
  void load(handle, cwd, sessionPath, atp);
  return handle;
}

/**
 * Open the chat on the host. The answer brings the host's snapshot of it (the last page of turns, a line for each
 * earlier one); what pi says meanwhile waits for it and applies on top, as when joining a live chat.
 */
async function load(handle: string, cwd: string, sessionPath: string | undefined, atp: AtpSession | undefined): Promise<void> {
  attaching.set(handle, []);
  let opened: OpenSessionResult;
  try {
    opened = await studio().openSession({ handle, cwd, sessionPath, atp });
  } catch (error) {
    attaching.delete(handle);
    toast(`Could not open session: ${(error as Error).message}`, "error");
    removeSession(handle);
    return;
  }
  const buffered = attaching.get(handle) ?? [];
  attaching.delete(handle);
  const { snapshot } = opened;
  if (opened.handle && opened.handle !== handle) {
    // The file was already live under the host's handle (a chat another client started): join that one.
    const wasActive = store.get().active === handle;
    removeSession(handle);
    if (!snapshot || store.get().sessions[opened.handle] || attaching.has(opened.handle)) return void adopt(opened.handle, wasActive);
    install(opened.handle, snapshot, []);
    if (wasActive) activate(opened.handle);
    return;
  }
  // A prefill that came before the answer stays.
  const editorText = store.get().sessions[handle]?.editorText;
  if (snapshot) install(handle, snapshot, buffered, editorText);
  else {
    patchSession(handle, (s) => ({ ...s, loading: undefined }));
    for (const batch of buffered) handleBatch(batch);
  }
}

let windowFocused = true;

/** The chat is on screen: active, no page over it, and the window focused. */
const viewing = (handle: string) => (store.get().page ? pageChat === handle : store.get().active === handle) && windowFocused;

/** You are looking at this chat: clear its unread mark. */
function markRead(handle: string | undefined): void {
  if (handle && store.get().sessions[handle]?.unread) patchSession(handle, (s) => ({ ...s, unread: undefined }));
}

/** Show a chat (leaving any page). */
export function activate(handle: string | undefined): void {
  const previous = store.get().active;
  if (store.get().page) store.set((state) => ({ ...state, page: undefined }));
  markRead(handle);
  if (previous === handle) return;
  store.set((state) => ({ ...state, active: handle }));
  const prev = previous ? store.get().sessions[previous] : undefined;
  // Leaving a chat nobody needs lets the host stop its pi (once no other client holds it).
  if (prev && isDisposable(prev)) void detachSession(prev.handle);
}

/** Drop a chat from this window without stopping it; the host ends its pi when it is idle and nobody else is in it. */
async function detachSession(handle: string): Promise<void> {
  removeSession(handle);
  await studio().detachSession(handle);
}

/** Events that arrive while a chat's snapshot is being fetched wait here, then apply if they are newer than it. */
const attaching = new Map<string, HostEventBatch[]>();

/** Join a chat the host already runs (another client started it, or this window had it before a reload). */
export async function adopt(handle: string, show = false): Promise<void> {
  if (store.get().sessions[handle] || attaching.has(handle)) return;
  attaching.set(handle, []);
  const snapshot = await studio().attachSession(handle).catch(() => null);
  const buffered = attaching.get(handle) ?? [];
  attaching.delete(handle);
  if (!snapshot) return;
  install(handle, snapshot, buffered);
  if (show) activate(handle);
}

/** Show a chat as the host's snapshot has it, then the events that came after the snapshot (`buffered` meanwhile). */
function install(handle: string, snapshot: ChatSnapshot & { seq: number }, buffered: HostEventBatch[], editorText?: SessionState["editorText"]): void {
  const state = snapshot.state as unknown as SessionState;
  const session: SessionState = {
    ...state,
    ...(snapshot.outline?.length && { earlier: snapshot.outline, ...(snapshot.turns.offset && { earlierOffset: snapshot.turns.offset }) }),
    ...(editorText && { editorText }),
  };
  store.set((s) => ({ ...s, sessions: { ...s.sessions, [handle]: session }, open: s.open.includes(handle) ? s.open : [...s.open, handle] }));
  for (const batch of buffered) if ((batch.seq ?? Number.POSITIVE_INFINITY) > snapshot.seq) handleBatch(batch);
  if (session.phase === "ready") void onReady(handle, { messageCount: session.items.length } as RpcSessionState);
}

/** Turns per earlier page: the most the host serves at once. */
const EARLIER_TURNS = 40;
/** Paging of a chat runs one request after the other, so a jump and a scroll never load the same page twice. */
const paging = new Map<string, Promise<void>>();

/**
 * Load the host's turns before the ones the chat shows: one page (the host makes it smaller when its turns are big),
 * or every page down to turn `to` (a jump to an earlier turn). Events keep applying to the end of the transcript meanwhile.
 */
export function loadEarlier(handle: string, to?: number): Promise<void> {
  const next = (paging.get(handle) ?? Promise.resolve()).catch(() => undefined).then(() => pageIn(handle, to));
  paging.set(handle, next);
  void next.finally(() => paging.get(handle) === next && paging.delete(handle)).catch(() => undefined);
  return next;
}

async function pageIn(handle: string, to: number | undefined): Promise<void> {
  const session = store.get().sessions[handle];
  if (!session?.earlier?.length) return;
  const outline = session.earlier;
  const target = to === undefined ? 0 : Math.max(0, Math.min(to, outline.length - 1));
  const pages: SessionState[] = [];
  // Where the loaded items start: a turn's prompt, or `offset` items into the turn (the last outlined one).
  let offset = session.earlierOffset ?? 0;
  let before = offset ? outline.length - 1 : outline.length;
  do {
    const turns = Math.min(EARLIER_TURNS, before + (offset ? 1 : 0) - target);
    const page = await studio().pageSession(handle, before, turns, ...(offset ? [offset] : []));
    pages.unshift(page.value.state as unknown as SessionState);
    before = page.value.turns.from;
    offset = page.value.turns.offset ?? 0;
  } while (to !== undefined && (before > target || (before === target && offset > 0)));
  patchSession(handle, (s) => {
    if (s.earlier !== outline) return s; // the chat was replaced meanwhile
    const items = [...pages.flatMap((page) => page.items), ...s.items];
    const left = offset ? before + 1 : before;
    return { ...s, items, earlier: left > 0 ? outline.slice(0, left) : undefined, earlierOffset: offset || undefined };
  });
}

const earlierOf = new WeakMap<TurnOutline[], EarlierTurns>();

/** The host's turns before the ones a chat shows, for its Transcript: one line each until they are paged in. */
export function earlierTurns(session: SessionState): EarlierTurns | undefined {
  const outline = session.earlier;
  if (!outline?.length) return undefined;
  let earlier = earlierOf.get(outline);
  if (!earlier) {
    const { handle } = session;
    const previews = new Map<number, Promise<string>>();
    earlier = {
      count: outline.length,
      outline,
      load: () => loadEarlier(handle),
      reach: async (key) => {
        const index = outline.findIndex((turn) => turn.key === key);
        if (index >= 0) await loadEarlier(handle, index);
      },
      preview: (index) => {
        let preview = previews.get(index);
        if (!preview) {
          preview = studio().pageSession(handle, index + 1, 1).then((page) => pagePreview(page.value.state as unknown as SessionState));
          preview.catch(() => previews.delete(index));
          previews.set(index, preview);
        }
        return preview;
      },
    };
    earlierOf.set(outline, earlier);
  }
  return earlier;
}

/** Attention updates: a chat that is doing something and is not here yet was started elsewhere; join it. */
function onAttention(chats: AttentionSummary[], removed: string[]): void {
  for (const handle of removed) if (store.get().sessions[handle]?.phase !== "exited" && !attaching.has(handle)) removeSession(handle);
  for (const chat of chats) if (chat.attention !== "idle" && !store.get().sessions[chat.handle]) void adopt(chat.handle);
}

/** A chat a page shows beside itself (the ATP page's side column): looked at while that page is open. */
let pageChat: string | undefined;
export function showPageChat(handle: string | undefined): void {
  pageChat = handle;
  if (windowFocused) markRead(handle);
  syncViewing();
}

/** A page stopped showing a chat it opened beside itself: drop it from this window unless something needs it. */
export function releasePageChat(handle: string): void {
  const session = store.get().sessions[handle];
  if (session && store.get().active !== handle && isDisposable(session)) void detachSession(handle);
}

// Which chat the host is told this window is looking at.
let reportedViewing: string | undefined;
function syncViewing(): void {
  syncShown();
  const { active, page, sessions } = store.get();
  const shown = page ? pageChat : active;
  const now = windowFocused && shown && sessions[shown] ? shown : undefined;
  if (now === reportedViewing) return;
  if (reportedViewing) studio().viewing(reportedViewing, false);
  if (now) studio().viewing(now, true);
  reportedViewing = now;
}

// The chats the host is told this window has on screen, focused or not: the active one (also behind a page) and a
// page's side chat. The host does not stop their pi for being idle.
let reportedShown: string[] = [];
function syncShown(): void {
  const { active, page, sessions } = store.get();
  const now = [...new Set([active, page ? pageChat : undefined])].filter((handle): handle is string => handle !== undefined && sessions[handle] !== undefined);
  if (now.length === reportedShown.length && now.every((handle, index) => handle === reportedShown[index])) return;
  for (const handle of reportedShown) if (!now.includes(handle)) studio().shown(handle, false);
  for (const handle of now) if (!reportedShown.includes(handle)) studio().shown(handle, true);
  reportedShown = now;
}

export async function closeSession(handle: string, pickNext = true): Promise<void> {
  const { open, active, sessions } = store.get();
  if (pickNext && active === handle) {
    // The next chat the sidebar shows: ATP chats are not on it.
    const shown = open.filter((other) => other === handle || !sessions[other]?.atp);
    const index = shown.indexOf(handle);
    const next = shown[index + 1] ?? shown[index - 1];
    store.set((state) => ({ ...state, active: next }));
  }
  removeSession(handle);
  await studio().closeSession(handle);
}

function removeSession(handle: string): void {
  removeComposerCard(handle);
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
  const waiting = attaching.get(handle);
  if (waiting) {
    waiting.push(batch);
    return;
  }
  if (!store.get().sessions[handle]) return;
  patchSession(handle, (session) => events.reduce((s, event) => reduceHostEvent(s, event, Date.now()), session));

  for (const event of events) {
    if (event.kind === "ready") void onReady(handle, event.state);
    else if (event.kind === "closed") {
      // Another client closed the chat: leave it (the desktop's own close already removed it).
      if (event.by !== "desktop") removeSession(handle);
    } else if (event.kind === "dialog_resolved" || event.kind === "lease") continue;
    else if (event.kind === "exit") {
      // A spawn failure (pi not installed) is explained in the session's banner; keep the toast short.
      if (event.error) toast("pi could not start", "error");
      else if (event.code !== 0 && event.signal !== "SIGTERM") toast(`pi exited (${event.signal ?? `code ${event.code}`})`, "error");
    } else if (event.record.type === "extension_ui_request" && event.record.method === "notify") {
      const level = event.record.notifyType === "error" ? "error" : event.record.notifyType === "warning" ? "warning" : "info";
      // Every pi process repeats the same extension startup notices; show each one once per app run.
      const starting = store.get().sessions[handle]?.phase === "starting";
      // Startup chatter ("X loaded") stays in the terminal log; startup warnings still toast once.
      if (starting && level === "info") continue;
      if (starting && seenStartupNotices.has(event.record.message)) continue;
      if (starting) seenStartupNotices.add(event.record.message);
      toast(event.record.message, level);
    } else if (event.record.type === "agent_settled") {
      const outcome = runOutcome(store.get().sessions[handle]?.items ?? []);
      // Finished while you were not looking: another chat or a page was open, or the window was in the background.
      // (A card's background chat that ended well is closed by the host, so it never gets here.)
      if (!viewing(handle)) patchSession(handle, (s) => ({ ...s, unread: outcome }));
      void onSettled(handle);
    }
    // Context grows every turn and shrinks on compaction; get_session_stats is cheap (ms, even at 40 MB).
    else if (event.record.type === "turn_end" || event.record.type === "compaction_end") scheduleStats(handle);
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
    patchSession(handle, (s) => ({
      ...s,
      sessionPath: data.sessionFile ?? s.sessionPath,
      name: data.sessionName ?? s.name,
      model: data.model ?? s.model,
      autoCompaction: data.autoCompactionEnabled,
    }));
  }
  // The chat's row in the sidebar comes from the host, which re-indexes the settled file (`onSessionIndexed`).
}

const statsTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleStats(handle: string): void {
  clearTimeout(statsTimers.get(handle));
  statsTimers.set(
    handle,
    setTimeout(() => {
      statsTimers.delete(handle);
      void refreshStats(handle);
    }, 300),
  );
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

export async function send(handle: string, text: string, mode: SendMode): Promise<boolean> {
  const session = store.get().sessions[handle];
  if (!session || session.phase === "exited") return false;
  const isCommand = text.startsWith("/");
  const annotations = isCommand ? [] : (store.get().annotations[handle] ?? []);
  const attachments = store.get().attachments[handle] ?? [];
  // A command is not a message about the card: the card waits for the next one.
  const card = isCommand ? undefined : composerCard(store.get(), handle);
  const message = [card && cardBlock(card), text, formatAnnotations(annotations), formatFileMentions(attachments)].filter(Boolean).join("\n\n");
  const images: ImageContent[] = [
    ...attachmentImages(attachments),
    ...annotations.flatMap((a) => (a.image ? [{ type: "image" as const, data: a.image, mimeType: "image/jpeg" }] : [])),
  ];
  const cmd: RpcCommand = { type: "prompt", message, images: images.length ? images : undefined };
  if (session.running && !isCommand) cmd.streamingBehavior = mode === "followUp" ? "followUp" : "steer";
  patchSession(handle, (s) => ({ ...s, prompted: true }));
  const response = await command<{ disposition: string }>(handle, cmd);
  if (response.success && card) {
    removeComposerCard(handle);
    void joinCard(handle, card.id);
  }
  if (response.success && attachments.length) {
    const sent = new Set(attachments.map((a) => a.id));
    store.set((s) => ({ ...s, attachments: { ...s.attachments, [handle]: (s.attachments[handle] ?? []).filter((a) => !sent.has(a.id)) } }));
  }
  if (response.success && annotations.length) {
    const sent = new Set(annotations.map((a) => a.id));
    store.set((s) => ({ ...s, annotations: { ...s.annotations, [handle]: (s.annotations[handle] ?? []).filter((a) => !sent.has(a.id)) } }));
    if (store.get().browser.annotating && store.get().active === handle) window.studio.browser.annotate(false);
  }
  return response.success;
}

// ── Attachments ──────────────────────────────────────────────────────────────

export function addAttachments(handle: string, incoming: Attachment[]): void {
  if (!incoming.length) return;
  store.set((s) => ({ ...s, attachments: { ...s.attachments, [handle]: mergeAttachments(s.attachments[handle] ?? [], incoming) } }));
}

export function removeAttachment(handle: string, id: string): void {
  store.set((s) => ({ ...s, attachments: { ...s.attachments, [handle]: (s.attachments[handle] ?? []).filter((a) => a.id !== id) } }));
}

export async function pickAttachments(handle: string, kind: "photos" | "files"): Promise<void> {
  addAttachments(handle, await pickFiles(kind));
}

/** The native picker's choice as attachments. */
export async function pickFiles(kind: "photos" | "files"): Promise<Attachment[]> {
  return (await studio().pickAttachments(kind)).map(fromPicked);
}

export async function attachFiles(handle: string, files: File[]): Promise<void> {
  addAttachments(handle, await readFiles(files));
}

/**
 * Dropped or pasted Files as attachments: anything with a path (Finder files and folders) is described by main;
 * in-memory images (a screenshot copied to the clipboard) are read right away, since clipboard
 * data does not outlive the event.
 */
export async function readFiles(files: File[]): Promise<Attachment[]> {
  const paths: string[] = [];
  const pending: Promise<Attachment>[] = [];
  for (const file of files) {
    const path = studio().pathForFile(file);
    if (path) paths.push(path);
    else if (file.type.startsWith("image/")) pending.push(readImage(file));
  }
  const [described, images] = await Promise.all([paths.length ? studio().describePaths(paths) : [], Promise.all(pending)]);
  return [...described.map(fromPicked), ...images];
}

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(fromImageData(file.name || "pasted image", file.type, String(reader.result).split(",")[1] ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function removeAnnotation(handle: string, id: string): void {
  store.set((s) => ({ ...s, annotations: { ...s.annotations, [handle]: (s.annotations[handle] ?? []).filter((a) => a.id !== id) } }));
}

// ── Browser pane ─────────────────────────────────────────────────────────────

/** Change the pane of the chat on screen (`split` is shared by all chats). */
export function setPane(patch: Partial<AppState["pane"]>): void {
  store.set((s) => ({ ...s, pane: { ...s.pane, ...patch } }));
}

/** Open the browser of the chat on screen, leaving any page, which would cover it. */
export function showBrowser(): void {
  if (!store.get().active) return;
  closePage();
  setPane({ open: true });
}

/** The browser belongs to the chat on screen; without one there is nothing to open it for. */
export function toggleBrowser(): void {
  const { pane, browser, active, page } = store.get();
  if (!active) return;
  if (page || !pane.open) {
    showBrowser();
    if (browser.tabs.length === 0) window.studio.browser.newTab();
  } else setPane({ open: false, full: false });
}

/** The tabs a chat owns out of every chat's; the active tab only when it is one of them. */
export function scopeBrowser(all: BrowserState, chat: string | undefined): BrowserState {
  const tabs = chat ? all.tabs.filter((tab) => tab.agent === chat) : [];
  return { ...all, tabs, activeId: tabs.some((tab) => tab.id === all.activeId) ? all.activeId : undefined };
}

/** The chats whose last pane tab is gone from `before` to `after` (window tabs live in their own window and do not count). */
export function emptiedPanes(before: BrowserState, after: BrowserState): string[] {
  const owners = (state: BrowserState) =>
    new Set(state.tabs.filter((tab) => tab.agent && (tab.surface ?? "pane") === "pane").map((tab) => tab.agent as string));
  const left = owners(after);
  return [...owners(before)].filter((chat) => !left.has(chat));
}

/** The agent works in `chat`'s browser: its pane opens, whether or not the chat is on screen. */
function revealBrowser(chat: string | undefined): void {
  if (!chat) return;
  if (store.get().active === chat) return setPane({ open: true });
  store.set((s) => ({ ...s, panes: { ...s.panes, [chat]: { full: false, ...s.panes[chat], open: true } } }));
}

// Which chat's browser is on screen: its pane state and tabs replace the previous chat's, and main is told.
let shownBrowser: { chat?: string; all?: BrowserState } = {};
function syncBrowser(): void {
  const { active, browserAll, pane, panes } = store.get();
  if (shownBrowser.chat === active && shownBrowser.all === browserAll) return;
  const switched = shownBrowser.chat !== active;
  const previous = shownBrowser.chat;
  const emptied = shownBrowser.all ? emptiedPanes(shownBrowser.all, browserAll) : [];
  shownBrowser = { chat: active, all: browserAll };
  if (switched) {
    window.studio.browser.focus(active);
    const next = active ? panes[active] : undefined;
    store.set((s) => ({
      ...s,
      panes: previous ? { ...s.panes, [previous]: { open: pane.open, full: pane.full } } : s.panes,
      pane: { ...s.pane, open: next?.open ?? false, full: next?.full ?? false },
      browser: scopeBrowser(browserAll, active),
    }));
  } else {
    store.set((s) => ({ ...s, browser: scopeBrowser(browserAll, active) }));
  }
  // Closing a chat's last pane tab closes its pane, rather than leaving an empty start page.
  if (emptied.length === 0) return;
  store.set((s) => {
    const panes = { ...s.panes };
    for (const chat of emptied) if (panes[chat]) panes[chat] = { ...panes[chat], open: false, full: false };
    return { ...s, panes, pane: active && emptied.includes(active) ? { ...s.pane, open: false, full: false } : s.pane };
  });
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

export function setSidebar(patch: Partial<SidebarLayout>, persist = true): void {
  store.set((s) => ({ ...s, sidebar: { ...s.sidebar, ...patch } }));
  if (persist) saveSidebar(store.get().sidebar);
}

export function toggleSidebar(): void {
  setSidebar({ collapsed: !store.get().sidebar.collapsed });
}

export function newChat(): void {
  const { active, sessions } = store.get();
  const cwd = active && sessions[active]?.cwd;
  newSession((cwd && projectOf(cwd)) || studio().launchCwd || studio().homeDir);
}

export function openLightbox(src: string | undefined, images?: string[]): void {
  store.set((s) => ({ ...s, lightbox: src ? lightboxAt(src, images) : undefined }));
}

/** The lightbox `delta` images on (arrow keys); stops at the ends. */
export function stepLightbox(delta: number): void {
  store.set((s) => (s.lightbox ? { ...s, lightbox: lightboxStep(s.lightbox, delta) } : s));
}

/** Edit pi's queues (trash, steer now, defer, take out to edit); the host does it atomically per chat. */
export async function editQueue(handle: string, op: QueueOp): Promise<boolean> {
  if (!store.get().sessions[handle]?.running) return false;
  return studio().editQueue(handle, op);
}

/** Esc: the host restores queued messages (returned), then aborts the agent run or manual compaction. */
export async function interrupt(handle: string): Promise<string[]> {
  const session = store.get().sessions[handle];
  if (!session || (!session.running && !session.compacting)) return [];
  return studio().interrupt(handle);
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

/** Answer a dialog. The card goes when the host took the answer, or says it was settled elsewhere first (dialog_resolved does the same). */
export async function respondDialog(handle: string, response: ExtensionUiResponse): Promise<void> {
  const drop = () => patchSession(handle, (s) => ({ ...s, dialogs: s.dialogs.filter((d) => d.id !== response.id) }));
  const answer = await studio().respondDialog(handle, response).catch((error) => ({ ok: false as const, code: "internal" as const, message: remoteError(error) }));
  if (answer.ok || answer.code === "already_answered" || answer.code === "not_found") drop();
  else toast(`Could not answer: ${answer.message}`, "error");
}

export async function compact(handle: string): Promise<void> {
  await command(handle, { type: "compact" });
}

export function toggleExpandAll(): void {
  store.set((state) => ({ ...state, expandAll: !state.expandAll, expanded: {} }));
}

/** Put text in a session's composer (suggestions, like an extension's set_editor_text). */
export function prefill(handle: string, text: string): void {
  patchSession(handle, (s) => ({ ...s, editorText: { text, nonce: Date.now() } }));
}

export function setExpanded(key: string, open: boolean): void {
  store.set((state) => ({ ...state, expanded: { ...state.expanded, [key]: open } }));
}

// ── Kanban ───────────────────────────────────────────────────────────────────

/** The revision of the board this window shows. */
export const boardRev = (): number => store.get().board.rev;

/** Text for a refused change; a conflict (someone else changed the field since this window read it) says to look again. */
function editError(error: unknown): string {
  const message = remoteError(error);
  return message.startsWith("Conflict:") ? "That changed elsewhere meanwhile; the latest version is shown. Make your change again." : message;
}

/**
 * Change the board. Applied here first, so a drop lands without waiting for main; main checks the op again,
 * saves it and pushes the board back. A text edit is checked against `baseRev`, the board revision the editor last
 * showed (default: this window's current one); main refuses it when that text changed since. Returns false (after a toast) when the op is refused.
 */
export async function applyBoard(op: BoardOp, baseRev?: number): Promise<boolean> {
  const local = op.type === "add" && !op.id ? { ...op, id: freshId(store.get().board) } : op;
  const before = store.get().board;
  try {
    // The optimistic board keeps the revision it was edited from: that is the baseRev main checks text edits against.
    const board = { ...applyOp(before, local, Date.now()), rev: before.rev };
    store.set((s) => ({ ...s, board }));
    await studio().board.apply(local, baseRev ?? before.rev);
    return true;
  } catch (error) {
    // Main refused it (or the card changed meanwhile): its board is the truth. When main cannot answer either (a
    // window newer than main, StudioApi.stale), undo the change so nothing looks saved that is not.
    if (!(error instanceof BoardError)) {
      void studio()
        .board.get()
        .then(
          (board) => store.set((s) => ({ ...s, board })),
          () => store.set((s) => ({ ...s, board: before })),
        );
    }
    toast(editError(error), "error");
    return false;
  }
}

const PAGE_PROJECT = "pigna:kanban-project";

/** The feature a page belongs to; Settings is always there. */
const pageFeature = (kind: Page): Feature | undefined => (kind === "settings" ? undefined : kind);
const pageOn = (page: PageState | undefined, settings = store.get().settings): boolean => {
  const feature = page && pageFeature(page.kind);
  return feature === undefined || settings.features[feature];
};

/** Open a project's page: by default the active chat's project, else the project of the page you looked at last. */
export function showPage(kind: Page, cwd?: string, card?: string): void {
  if (kind === "settings") return openSettings();
  const feature = pageFeature(kind);
  if (feature && !store.get().settings.features[feature]) {
    toast(`${FEATURE_LABELS[feature]} is turned off in Settings (⌘,)`, "warning");
    return;
  }
  const { active, sessions } = store.get();
  const chat = active && sessions[active]?.cwd;
  const project = cwd ?? (chat && projectOf(chat)) ?? localStorage.getItem(PAGE_PROJECT) ?? (studio().launchCwd || studio().homeDir);
  localStorage.setItem(PAGE_PROJECT, project);
  store.set((s) => ({ ...s, page: { kind, cwd: project, card } }));
}

/** Open a project's board, maybe with a card open. */
export const showBoard = (cwd?: string, card?: string): void => showPage("kanban", cwd, card);

/** Open a card's details on the board page, or close them. */
export function openCard(card: string | undefined): void {
  store.set((s) => (s.page ? { ...s, page: { ...s.page, card } } : s));
}

/** Back to the active chat. */
export function closePage(): void {
  if (!store.get().page) return;
  store.set((s) => ({ ...s, page: undefined }));
  markRead(store.get().active);
}

/** From the menu: open a page or close it; Settings opens at `section`, or switches to it. */
export function togglePage(page: Page, section?: SettingsSection): void {
  const current = store.get().page;
  if (page === "settings") {
    if (current?.kind === "settings" && (!section || section === current.section)) closeSettings();
    else openSettings(section);
  } else if (current?.kind === page) closePage();
  else showPage(page, current?.kind === "settings" ? (current.back?.cwd ?? current.cwd) : current?.cwd); // from the other page: the same project
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** The Settings page, at `section` (General at first); it covers whatever was shown, which "Back to app" returns to. */
export function openSettings(section?: SettingsSection): void {
  const current = store.get().page;
  if (current?.kind === "settings") {
    if (section && section !== current.section) store.set((s) => ({ ...s, page: { ...current, section } }));
    return;
  }
  const { active, sessions } = store.get();
  const chat = active && sessions[active]?.cwd;
  const cwd = current?.cwd ?? (chat ? projectOf(chat) : undefined) ?? localStorage.getItem(PAGE_PROJECT) ?? (studio().launchCwd || studio().homeDir);
  store.set((s) => ({ ...s, page: { kind: "settings", cwd, section: section ?? "general", back: current } }));
}

/** Back to the page or chat Settings was opened from. */
export function closeSettings(): void {
  const current = store.get().page;
  if (current?.kind !== "settings") return;
  if (current.back && pageOn(current.back)) store.set((s) => ({ ...s, page: current.back }));
  else closePage();
}

/** Change pi-gna's settings: applied here first, then main checks, saves and pushes them back. False after a toast. */
export async function applySettings(op: SettingsOp): Promise<boolean> {
  const before = store.get().settings;
  try {
    onSettings({ ...applySettingsOp(before, op), rev: before.rev });
    await studio().settings.apply(op, before.rev);
    return true;
  } catch (error) {
    void studio()
      .settings.get()
      .then(onSettings, () => onSettings(before));
    toast(editError(error), "error");
    return false;
  }
}

/** New settings: a page of a feature you turned off closes (Settings forgets it as the page to go back to). */
function onSettings(settings: Revved<Settings>): void {
  store.set((s) => {
    if (s.settings === settings) return s;
    const page = s.page;
    if (!page || pageOn(page, settings)) {
      const back = page?.back && !pageOn(page.back, settings) ? undefined : page?.back;
      return { ...s, settings, page: page && back !== page.back ? { ...page, back } : page };
    }
    return { ...s, settings, page: undefined };
  });
}

export const useFeature = (feature: Feature): boolean => useApp((state) => state.settings.features[feature]);

// ── Themes and laments ────────────────────────────────────────────────────────
/** Change a theme; false after a toast (a bad color, an image outside the project). */
export async function applyTheme(op: ThemeOp): Promise<boolean> {
  try {
    await studio().themes.apply(op, store.get().themes.rev);
    return true;
  } catch (error) {
    toast(remoteError(error), "error");
    return false;
  }
}

/**
 * Resolve, reopen or delete a lament, or record its Fix chat. Applied here first, like applyBoard, so it moves without
 * waiting for main; main checks it again, saves it and pushes the laments back. False after a toast.
 */
export async function applyLament(op: LamentOp): Promise<boolean> {
  const before = store.get().laments;
  try {
    const laments = { ...applyLamentOp(before, op, Date.now()), rev: before.rev };
    store.set((s) => ({ ...s, laments }));
    await studio().laments.apply(op, before.rev);
    return true;
  } catch (error) {
    // Refused here (nothing changed) or by main: main's laments are the truth, or the ones from before when it cannot answer.
    if (!(error instanceof LamentError)) {
      void studio()
        .laments.get()
        .then(
          (laments) => store.set((s) => ({ ...s, laments })),
          () => store.set((s) => ({ ...s, laments: before })),
        );
    }
    toast(remoteError(error), "error");
    return false;
  }
}

/**
 * Fix a lament: a new chat in the background works in the lament's git worktree, on a branch of its own (made by
 * main, reused by later Fixes), and is recorded on the lament once pi knows its session file. It does not resolve
 * the lament: you mark it resolved once the fix is in.
 */
export function fixLament(lament: Lament): Promise<boolean> {
  const key = taskKey.fix(lament.id);
  return trackStart(key, (phase) => setTaskStart(key, phase), () => startTask({ kind: "fix", lament: lament.id }));
}

/**
 * Review a pull request (the GitHub page): a new chat in the project, shown, whose first message asks for a review
 * with pi-gna's pr-review skill. `login`: the gh account pi-gna reads the repository as.
 */
export function reviewPullRequest(cwd: string, repo: GithubRepo, item: GithubItem, login?: string): Promise<boolean> {
  const key = taskKey.review(cwd, repo, item);
  return trackStart(key, (phase) => setTaskStart(key, phase), () => startTask({ kind: "review", cwd, repo, item, login }, true));
}

/** The keys of AppState.taskStarts. */
export const taskKey = {
  fix: (lament: string) => `fix ${lament}`,
  review: (cwd: string, repo: GithubRepo, item: GithubItem) => `review ${cwd} ${repo.host}/${repo.repo}#${item.number}`,
};

/** Where a task's chat is (taskKey): starting, just started, or neither. */
export const useTaskStart = (key: string): CardTaskPhase | undefined => useApp((state) => state.taskStarts[key]);

function setTaskStart(key: string, phase: CardTaskPhase | undefined): void {
  store.set((s) => {
    if (s.taskStarts[key] === phase) return s;
    const { [key]: _previous, ...rest } = s.taskStarts;
    return { ...s, taskStarts: phase ? { ...rest, [key]: phase } : rest };
  });
}

const startedTimers = new Map<string, ReturnType<typeof setTimeout>>();
const startingNow = new Set<string>();

/**
 * Start something shown as starting (`show`), then started for a moment (CARD_TASK_STARTED_MS), or as nothing when
 * `run` fails (it toasts why). Asked again while it starts (a double click), it does nothing, so it starts one chat.
 */
async function trackStart(key: string, show: (phase: CardTaskPhase | undefined) => void, run: () => Promise<boolean>): Promise<boolean> {
  if (startingNow.has(key)) return false;
  startingNow.add(key);
  clearTimeout(startedTimers.get(key));
  startedTimers.delete(key);
  show("starting");
  const started = await run().finally(() => startingNow.delete(key));
  if (!started) {
    show(undefined);
    return false;
  }
  show("started");
  startedTimers.set(
    key,
    setTimeout(() => {
      startedTimers.delete(key);
      show(undefined);
    }, CARD_TASK_STARTED_MS),
  );
  return true;
}

/**
 * Start a task's chat on the host (main sets it up: worktree, link to the card or lament, model, prompt, name) and join
 * it. Shown in the sidebar only for `show`; the host says what it is doing and what it could not set up. False after a
 * toast.
 */
async function startTask(target: TaskTarget, show = false): Promise<boolean> {
  try {
    const started = await studio().startTask(target);
    for (const notice of started.notices) toast(notice.text, notice.level);
    await adopt(started.handle, show);
    return true;
  } catch (error) {
    toast(remoteError(error), "error");
    return false;
  }
}

export function showUpdate(open: boolean): void {
  store.set((s) => (s.updateOpen === open ? s : { ...s, updateOpen: open }));
}

/** ⌘K: open or close the search over chats, cards, pages and commands (`open` sets it). */
export function togglePalette(open = !store.get().palette): void {
  store.set((s) => (s.palette === open ? s : { ...s, palette: open }));
}

export function setOverlay(overlay: boolean): void {
  store.set((s) => (s.overlay === overlay ? s : { ...s, overlay }));
}

/** Put a chat on its project's board, as a new card in progress that the chat works on. */
export async function addChatToBoard(handle: string): Promise<void> {
  const session = store.get().sessions[handle];
  if (!session?.sessionPath) return;
  const id = freshId(store.get().board);
  const title = sessionTitle(session).slice(0, LIMITS.title);
  if (!(await applyBoard({ type: "add", id, title, cwd: projectOf(session.cwd), column: "in_progress" }))) return;
  await applyBoard({ type: "attach", id, chat: { path: session.sessionPath, cwd: session.cwd, label: title } });
}

/**
 * Add a card from one description and what you attached, at the bottom of `column`: titled with the description's
 * start until a quick chat in the background (the triage model, Settings > Models) names, tags and briefly investigates
 * it. Main does it all (saves the images, lists them in the notes, starts the triage); the card shows when the board
 * changes. False after a toast.
 */
export async function addCard(cwd: string, column: Column, description: string, attachments: Attachment[] = []): Promise<boolean> {
  const text = description.trim();
  if (!text && !attachments.length) return false;
  try {
    await studio().addCard(
      cwd,
      column,
      text,
      attachments.map((a) => (a.kind === "image" ? { kind: "image", mimeType: a.mimeType, data: a.data } : { kind: "file", path: a.path })),
    );
    return true;
  } catch (error) {
    toast(remoteError(error), "error");
    return false;
  }
}

export type CardTaskKind = "investigate" | "resolve" | "qa";
/** Where a card task is: the host is setting its chat up (a worktree can take seconds), or it just did. */
export type CardTaskPhase = "starting" | "started";
export type CardTasks = Partial<Record<CardTaskKind, CardTaskPhase>>;
/** How long a card shows that its task's chat started. */
export const CARD_TASK_STARTED_MS = 2500;

function setCardTask(id: string, kind: CardTaskKind, phase: CardTaskPhase | undefined): void {
  store.set((s) => {
    const { [kind]: _previous, ...rest } = s.cardTasks[id] ?? {};
    const tasks = phase ? { ...rest, [kind]: phase } : rest;
    const { [id]: _card, ...others } = s.cardTasks;
    return { ...s, cardTasks: Object.keys(tasks).length ? { ...others, [id]: tasks } : others };
  });
}

/**
 * Start a card's Investigate, Resolve or QA chat (card-actions.ts): see ChatTasks in main. The card shows it starting,
 * then started for a moment; asking again while it starts (a double click) does nothing, so it starts one chat.
 */
export async function startCardTask(card: Card, kind: CardTaskKind): Promise<void> {
  await trackStart(`${kind} card ${card.id}`, (phase) => setCardTask(card.id, kind, phase), () => startTask({ kind, card: card.id }));
}

/** A card task in a chat that is already open (the card tab's default): the prompt goes to it and the chat joins the card. */
export async function runCardTaskHere(card: Card, kind: CardTaskKind, handle: string): Promise<void> {
  await trackStart(
    `${kind} card ${card.id}`,
    (phase) => setCardTask(card.id, kind, phase),
    async () => {
      if (!(await send(handle, inChatPrompt(card, kind), "followUp"))) {
        toast("That chat is not available", "error");
        return false;
      }
      await joinCard(handle, card.id);
      return true;
    },
  );
}

/**
 * "Chat about it": a new chat with the card in its composer, shown as a chip rather than as text you write under.
 * The card's details (cardBlock) go before your first message, and the chat joins the card then (see send).
 */
export function discussCard(card: Card): void {
  const handle = start(card.cwd);
  store.set((s) => ({ ...s, composerCards: { ...s.composerCards, [handle]: card.id } }));
}

/** The card in a chat's composer, while it is on the board. */
export function composerCard(state: AppState, handle: string): Card | undefined {
  const id = state.composerCards[handle];
  return id === undefined ? undefined : state.board.cards.find((card) => card.id === id);
}

/** Take the card out of a chat's composer: the chat is not told about it and does not join it. */
export function removeComposerCard(handle: string): void {
  store.set((s) => {
    if (!(handle in s.composerCards)) return s;
    const { [handle]: _removed, ...composerCards } = s.composerCards;
    return { ...s, composerCards };
  });
}

/** Open an earlier ATP chat (a node's worker, an orchestrator) from its session file, in the background: it never shows in the sidebar, the ATP page opens it. */
export function startAtpChat(cwd: string, atp: AtpSession, resume: { path: string; title: string }): string {
  return start(cwd, resume, false, atp);
}

/** Put a chat on a card, by its session file (the first message of a "Chat about it" chat). */
async function joinCard(handle: string, card: string): Promise<void> {
  const session = store.get().sessions[handle];
  if (!session) return;
  const path = session.sessionPath ?? (await command<RpcSessionState>(handle, { type: "get_state" }, true)).data?.sessionFile;
  if (path) await applyBoard({ type: "attach", id: card, chat: { path, cwd: session.cwd } });
  else toast("This chat has no session file, so it cannot be put on the card", "warning");
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let booted = false;
export function boot(): void {
  if (booted) return;
  booted = true;
  studio().onEvents(handleBatch);
  studio().onAttention(({ chats, removed }) => onAttention(chats, removed));
  studio().onSessionIndexed(({ path, summary }) => onSessionIndexed(path, summary));
  store.subscribe(syncViewing);
  void studio()
    .windowFocused()
    .then((focused) => {
      windowFocused = focused;
    });
  studio().onSidebarToggle(toggleSidebar);
  studio().onPaletteToggle(() => togglePalette());
  studio().onPageToggle(togglePage);
  studio().onOpenProject(newSession);
  studio().onWindowFocus((focused) => {
    windowFocused = focused;
    syncViewing();
    if (focused) markRead(store.get().page ? pageChat : store.get().active);
    // Back in the window: list the sessions folder again, for chats pi wrote outside pi-gna (pi in a terminal).
    if (focused) refreshProjects();
  });
  // A phone asked to pair: show the approval prompt (Settings > Remote access).
  studio().remote.onPairing((pairing) => pairing.state === "pending_approval" && openSettings("remote"));
  studio().settings.onChange(onSettings);
  void studio().settings.get().then(onSettings);
  bootUiState();
  studio().board.onChange((board) => store.set((s) => ({ ...s, board })));
  studio().laments.onChange((laments) => store.set((s) => ({ ...s, laments })));
  void studio()
    .laments.get()
    .then((laments) => store.set((s) => ({ ...s, laments })));
  studio().themes.onChange((themes) => store.set((s) => ({ ...s, themes })));
  void studio()
    .themes.get()
    .then((themes) => store.set((s) => ({ ...s, themes })));
  void studio()
    .board.get()
    .then((board) => store.set((s) => ({ ...s, board })));
  const browser = studio().browser;
  store.subscribe(syncBrowser);
  browser.onState((state) => store.set((s) => ({ ...s, browserAll: state })));
  browser.onReveal(revealBrowser);
  browser.onToggle(toggleBrowser);
  browser.onAnnotation((annotation, now) => {
    const chat = annotation.chat;
    if (!chat) return;
    store.set((s) => ({ ...s, annotations: { ...s.annotations, [chat]: [...(s.annotations[chat] ?? []), annotation] } }));
    // Send in the picker: this comment and any others waiting go now (steering a running chat); the composer's text
    // stays a draft. If pi does not take it, the comments stay in the composer.
    if (now) void send(chat, "", "send");
  });
  void browser.state().then((state) => state && store.set((s) => ({ ...s, browserAll: state })));
  const update = studio().update;
  update.onState((state) => store.set((s) => ({ ...s, update: state })));
  update.onReveal(() => showUpdate(true));
  void update.state().then((state) => store.set((s) => ({ ...s, update: state })));
  void studio()
    .compactionSettings()
    .then((compaction) => store.set((s) => ({ ...s, compaction })));
  refreshProjects();
  void resume();
}

/** Start: rejoin the chats the host still runs (a reloaded window), then show a draft in the launch folder. */
async function resume(): Promise<void> {
  const cwd = studio().launchCwd || studio().homeDir;
  const live = await studio().liveChats().catch((): AttentionSummary[] => []);
  await Promise.all(live.map((chat) => adopt(chat.handle)));
  const draft = Object.values(store.get().sessions).find((s) => s.cwd === cwd && !s.atp && s.phase !== "exited" && isDraft(s));
  if (draft) activate(draft.handle);
  else newSession(cwd);
}

/** Name, else the sidebar's title while loading, else first user message, else "New chat". */
export function sessionTitle(session: SessionState): string {
  if (session.name) return session.name;
  if (session.loading) return session.loading.title;
  // The first message is on a page this window has not loaded.
  if (session.earlier?.length) return session.earlier[0]!.label.slice(0, 120);
  const first = session.items.find((item) => item.kind === "user");
  if (first?.kind === "user") {
    const content = first.message.content;
    const text = typeof content === "string" ? content : (content.find((block) => block.type === "text") as { text?: string } | undefined)?.text;
    const clean = text ? stripStudioBlocks(text) : "";
    if (clean) return clean.replace(/\s+/g, " ").slice(0, 120);
  }
  return "New chat";
}

const chatsBySession = new WeakMap<SessionState, OpenChat>();
const chatsByHandle = new Map<string, OpenChat>();

/** What the chat lists show of a chat: the same object until one of its fields changes, so rows can skip rendering. */
export function openChat(session: SessionState): OpenChat {
  const known = chatsBySession.get(session);
  if (known) return known;
  const next: OpenChat = {
    handle: session.handle,
    cwd: session.cwd,
    sessionPath: session.sessionPath,
    title: sessionTitle(session),
    attention: attention(session),
    sentAt: sentAt(session),
    listed: isListed(session),
    draft: isDraft(session),
    exited: session.phase === "exited",
  };
  const previous = chatsByHandle.get(session.handle);
  const chat = previous && shallow(previous, next) ? previous : next;
  chatsByHandle.set(session.handle, chat);
  chatsBySession.set(session, chat);
  return chat;
}

/** The open chats as the lists show them; streaming into a chat does not change this. */
export const useOpenChats = (): OpenChat[] => useAppShallow((state) => openChats(state.sessions));

function openChats(sessions: Record<string, SessionState>): OpenChat[] {
  const chats = Object.values(sessions).map(openChat);
  // Forget closed chats.
  if (chatsByHandle.size > chats.length) for (const handle of chatsByHandle.keys()) if (!sessions[handle]) chatsByHandle.delete(handle);
  return chats;
}

/**
 * When you last sent a message from pi-gna, so the chat and its project move up right away instead of when the
 * index refreshes after the run. Chats only opened from disk count as untouched: their file time already says it.
 */
function sentAt(session: SessionState): number | undefined {
  if (!session.prompted) return undefined;
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i];
    if (item?.kind === "user") return item.message.timestamp;
  }
  return undefined;
}
