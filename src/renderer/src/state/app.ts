// App state and actions. Session state transitions live in shared/session-state.ts (pure); this module
// owns side effects: IPC calls, toasts, lifecycle of pi processes, and project refreshes.
import type { AtpSession } from "../../../shared/atp";
import { applyOp, type Board, BoardError, type BoardOp, type Card, type Column, emptyBoard, freshId, LIMITS, projectOf } from "../../../shared/board";
import type { Annotation, BrowserState } from "../../../shared/browser";
import type { GithubItem, GithubRepo } from "../../../shared/github";
import { emptyLaments, type Lament, type LamentOp, type Laments } from "../../../shared/laments";
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
import type { AttentionSummary, Revved } from "../../../shared/host-api";
import type { CardWorktree, HostEventBatch, Page, ProjectGroup, SessionSummary, UpdateState } from "../../../shared/ipc";
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
import { boardTags, cardBlock, cardNotes, draftTitle, pickModel, triageName, triagePrompt } from "../lib/board";
import { reviewName, reviewPrompt } from "../lib/github";
import { fixPrompt } from "../lib/laments";
import { loadSidebar, type SidebarLayout, saveSidebar } from "../lib/layout";
import { applyQueueOp, type QueueOp, type Queues } from "../../../shared/queue";
import { createSession, hydrate, isDisposable, isDraft, reduceHostEvent, type RunOutcome, runOutcome, type SessionState } from "../../../shared/session-state";
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
  browser: BrowserState;
  pane: { open: boolean; full: boolean; /** Browser share of the main area, 0..1. */ split: number };
  /** Browser comments waiting to ride along with the next prompt. */
  annotations: Annotation[];
  /** Composer attachments per session handle (picker, drag and drop, paste). */
  attachments: Record<string, Attachment[]>;
  /** The card in a chat's composer, per session handle ("Chat about it"): it goes with the chat's first message. */
  composerCards: Record<string, string>;
  sidebar: SidebarLayout;
  /** pi's compaction settings, for the context meter's auto-compaction point. */
  compaction: CompactionSettings;
  /** Full-size image overlay (data URL). Hides the native browser view while open. */
  lightbox?: string;
  /** Every project's Kanban cards. Main owns them (agents change them too) and pushes each change. */
  board: Revved<Board>;
  /** Every project's laments, which agents file; main owns them and pushes each change. */
  laments: Revved<Laments>;
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
  pane: { open: false, full: false, split: 0.5 },
  annotations: [],
  attachments: {},
  composerCards: {},
  compaction: {},
  sidebar: loadSidebar(),
  board: { ...emptyBoard(), rev: 0 },
  laments: { ...emptyLaments(), rev: 0 },
  settings: { ...emptySettings(), rev: 0 },
  overlay: false,
  update: { phase: "idle" },
  updateOpen: false,
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

async function load(handle: string, cwd: string, sessionPath: string | undefined, atp: AtpSession | undefined): Promise<void> {
  try {
    const opened = await studio().openSession({ handle, cwd, sessionPath, atp });
    const { entries } = opened;
    if (opened.handle && opened.handle !== handle) {
      // The file was already live under the host's handle (a chat another client started): join that one.
      const wasActive = store.get().active === handle;
      removeSession(handle);
      void adopt(opened.handle, wasActive);
      return;
    }
    patchSession(handle, (s) => {
      const loaded = s.loading ? { ...s, loading: undefined } : s;
      if (!entries.length) return loaded;
      // pi may already be ready (name, model) by the time the file is parsed; keep its live state.
      const hydrated = hydrate(loaded, entries);
      return { ...hydrated, name: s.name ?? hydrated.name, thinkingLevel: s.thinkingLevel ?? hydrated.thinkingLevel };
    });
  } catch (error) {
    toast(`Could not open session: ${(error as Error).message}`, "error");
    removeSession(handle);
  }
}

let windowFocused = true;

/** The chat is on screen: active, no page over it, and the window focused. */
const viewing = (handle: string) => store.get().active === handle && !store.get().page && windowFocused;

/** You are looking at this chat: clear its unread mark. */
function markRead(handle: string | undefined): void {
  if (handle && store.get().sessions[handle]?.unread) patchSession(handle, (s) => ({ ...s, unread: undefined }));
}

/** Show a chat (leaving any page). */
export function activate(handle: string | undefined): void {
  const previous = store.get().active;
  if (handle) backgroundChats.delete(handle); // you opened it: it stays open like any chat
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
async function adopt(handle: string, show = false): Promise<void> {
  if (store.get().sessions[handle] || attaching.has(handle)) return;
  attaching.set(handle, []);
  const snapshot = await studio().attachSession(handle).catch(() => null);
  const buffered = attaching.get(handle) ?? [];
  attaching.delete(handle);
  if (!snapshot) return;
  const session = snapshot.state as unknown as SessionState;
  store.set((state) => ({ ...state, sessions: { ...state.sessions, [handle]: session }, open: state.open.includes(handle) ? state.open : [...state.open, handle] }));
  for (const batch of buffered) if ((batch.seq ?? Number.POSITIVE_INFINITY) > snapshot.seq) handleBatch(batch);
  if (session.phase === "ready") void onReady(handle, { messageCount: session.items.length } as RpcSessionState);
  if (show) activate(handle);
}

/** Attention updates: a chat that is doing something and is not here yet was started elsewhere; join it. */
function onAttention(chats: AttentionSummary[], removed: string[]): void {
  for (const handle of removed) if (store.get().sessions[handle]?.phase !== "exited" && !attaching.has(handle)) removeSession(handle);
  for (const chat of chats) if (chat.attention !== "idle" && !store.get().sessions[chat.handle]) void adopt(chat.handle);
}

// Which chat the host is told this window is looking at.
let reportedViewing: string | undefined;
function syncViewing(): void {
  const { active, page, sessions } = store.get();
  const now = !page && windowFocused && active && sessions[active] ? active : undefined;
  if (now === reportedViewing) return;
  if (reportedViewing) studio().viewing(reportedViewing, false);
  if (now) studio().viewing(now, true);
  reportedViewing = now;
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
  // Its exit event finds no session any more: whoever waits for its run hears it now.
  if (store.get().sessions[handle]) settled(handle, "exited");
  settleListeners.delete(handle);
  cardLinks.delete(handle);
  setups.delete(handle);
  backgroundChats.delete(handle);
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
      settled(handle, "exited");
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
      settled(handle, outcome);
      // A card's background chat that ended well: what it found is on the card, so it closes instead of waiting to be read.
      if (backgroundChats.delete(handle) && outcome === "done" && store.get().active !== handle) void closeSession(handle, false);
      else {
        // Finished while you were not looking: another chat or a page was open, or the window was in the background.
        if (!viewing(handle)) patchSession(handle, (s) => ({ ...s, unread: outcome }));
        void onSettled(handle);
      }
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
  if (cardLinks.has(handle)) void linkCard(handle);
  const setup = setups.get(handle);
  if (setup) {
    setups.delete(handle);
    void setUp(handle, setup);
  }
}

/** How a chat's run ended, or that its pi exited. */
export type Settled = RunOutcome | "exited";
const settleListeners = new Map<string, Set<(how: Settled) => void>>();

/** Listen for a chat's runs ending (agent_settled) and for its pi exiting. */
export function onSettle(handle: string, listener: (how: Settled) => void): () => void {
  const listeners = settleListeners.get(handle) ?? new Set();
  listeners.add(listener);
  settleListeners.set(handle, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) settleListeners.delete(handle);
  };
}

function settled(handle: string, how: Settled): void {
  for (const listener of [...(settleListeners.get(handle) ?? [])]) listener(how);
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
  refreshProjects(300);
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
  const annotations = isCommand ? [] : store.get().annotations;
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
    void attachChat(handle, card.id);
  }
  if (response.success && attachments.length) {
    const sent = new Set(attachments.map((a) => a.id));
    store.set((s) => ({ ...s, attachments: { ...s.attachments, [handle]: (s.attachments[handle] ?? []).filter((a) => !sent.has(a.id)) } }));
  }
  if (response.success && annotations.length) {
    const sent = new Set(annotations.map((a) => a.id));
    store.set((s) => ({ ...s, annotations: s.annotations.filter((a) => !sent.has(a.id)) }));
    if (store.get().browser.annotating) window.studio.browser.annotate(false);
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

/** Browser comments as a prompt block; element crops travel as images in the same order. */
export function formatAnnotations(annotations: Annotation[]): string {
  if (!annotations.length) return "";
  const items = annotations.map((a, index) =>
    [
      `${index + 1}. ${a.comment}`,
      `   page: ${a.url}${a.title ? ` (${a.title})` : ""}`,
      `   element: ${a.label}  selector: ${a.selector}`,
      `   html: ${a.html.replace(/\s+/g, " ").slice(0, 400)}`,
    ].join("\n"),
  );
  const note = annotations.some((a) => a.image) ? " Attached images are crops of the commented elements, in order." : "";
  return `<browser-comments>\nThe user commented on elements in the pi-gna browser.${note}\n${items.join("\n")}\n</browser-comments>`;
}

export function removeAnnotation(id: string): void {
  store.set((s) => ({ ...s, annotations: s.annotations.filter((a) => a.id !== id) }));
}

// ── Browser pane ─────────────────────────────────────────────────────────────

export function setPane(patch: Partial<AppState["pane"]>): void {
  store.set((s) => ({ ...s, pane: { ...s.pane, ...patch } }));
}

export function toggleBrowser(): void {
  const { pane, browser } = store.get();
  setPane({ open: !pane.open, full: false });
  if (!pane.open && browser.tabs.length === 0) window.studio.browser.newTab();
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

export function openLightbox(src: string | undefined): void {
  store.set((s) => ({ ...s, lightbox: src }));
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

// ── Laments ──────────────────────────────────────────────────────────────────

/** Resolve, reopen or delete a lament, or record its Fix chat. Main applies it and pushes the laments back. */
export async function applyLament(op: LamentOp): Promise<boolean> {
  try {
    await studio().laments.apply(op);
    return true;
  } catch (error) {
    toast(remoteError(error), "error");
    return false;
  }
}

/**
 * Fix a lament: a new chat in the background works in the lament's git worktree, on a branch of its own (made by
 * main, reused by later Fixes), and is recorded on the lament once pi knows its session file. It does not resolve
 * the lament: you mark it resolved once the fix is in.
 */
export async function fixLament(lament: Lament): Promise<void> {
  let worktree: CardWorktree | null;
  try {
    worktree = await studio().lamentWorktree(lament.id);
  } catch (error) {
    toast(`Could not make a git worktree to fix “${lament.title}”: ${remoteError(error)}`, "error");
    return;
  }
  const branch = worktree?.branch;
  const handle = start(worktree?.cwd ?? lament.cwd, undefined, false);
  setups.set(handle, {
    name: `Fix: ${lament.title}`,
    prompt: fixPrompt(lament, worktree),
    link: (chat) => applyLament({ type: "fix", id: lament.id, chat, ...(branch ? { branch } : {}) }),
  });
  if (!worktree) toast(`Fixing “${lament.title}” in a new chat, in the project folder: it is not in a git repository`);
  else if (worktree.dirty) toast(`Fixing “${lament.title}” on branch ${worktree.branch}. Your checkout's uncommitted changes are not in its worktree.`, "warning");
  else toast(`Fixing “${lament.title}” on branch ${worktree.branch}`);
}

/**
 * Review a pull request (the GitHub page): a new chat in the project, shown, whose first message asks for a review
 * with pi-gna's pr-review skill (reviewPrompt). `login`: the gh account pi-gna reads the repository as.
 */
export function reviewPullRequest(cwd: string, repo: GithubRepo, item: GithubItem, login?: string): void {
  const handle = start(cwd);
  setups.set(handle, { name: reviewName(item), prompt: reviewPrompt(repo, item, login) });
}

export function showUpdate(open: boolean): void {
  store.set((s) => (s.updateOpen === open ? s : { ...s, updateOpen: open }));
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
 * start until a quick chat in the background (the triage model, Settings > Models) names, tags and briefly investigates it.
 */
export async function addCard(cwd: string, column: Column, description: string, attachments: Attachment[] = []): Promise<boolean> {
  const text = description.trim();
  if (!text && !attachments.length) return false;
  const id = freshId(store.get().board);
  if (!(await applyBoard({ type: "add", id, title: draftTitle(text) || "See the attachments", notes: text, cwd, column, before: null }))) return false;
  if (attachments.length && !(await attachToCard(id, text, attachments))) {
    void applyBoard({ type: "remove", id }); // main deletes the images saved for it
    return false;
  }
  const card = store.get().board.cards.find((other) => other.id === id);
  if (card) {
    const prompt = triagePrompt(card, boardTags(store.get().board, cwd));
    startCardChat(cwd, { card: id, name: triageName(card), prompt, model: taskModel(store.get().settings, "triage"), closeWhenDone: true });
  }
  return true;
}

/**
 * Save a new card's images (board.saveImage: main checks the card exists, so the card is added first) and list
 * them in its notes with the paths of attached files (cardNotes). False after a toast.
 */
async function attachToCard(id: string, text: string, attachments: Attachment[]): Promise<boolean> {
  try {
    const paths: string[] = [];
    // One at a time: when one fails, none is still being written as the card is removed.
    for (const a of attachments) paths.push(a.kind === "image" ? await studio().board.saveImage(id, { mimeType: a.mimeType, data: a.data }) : a.path);
    return await applyBoard({ type: "edit", id, notes: cardNotes(text, paths) });
  } catch (error) {
    toast(`Could not attach that to the card: ${remoteError(error)}`, "error");
    return false;
  }
}

/** A chat a card starts in the background, attached to it once pi knows its session file. */
interface CardLink {
  card: string;
  /** Session name, and the chat's label on the card. */
  name?: string;
  /** Sent once the chat is attached. */
  prompt: string;
  /** Run the prompt on this model instead of your default. */
  model?: TaskModel;
  /** Close the chat once its prompt's run ends well, unless you opened it; a failed run stays marked. */
  closeWhenDone?: boolean;
}
const cardLinks = new Map<string, CardLink>();
/** Background chats to close when their run ends well (CardLink.closeWhenDone) until you open them. */
const backgroundChats = new Set<string>();

/** Start a chat for a card in its project, in the background: attached to the card and sent its prompt when pi is ready. */
export function startCardChat(cwd: string, link: CardLink): string {
  const handle = start(cwd, undefined, false);
  cardLinks.set(handle, link);
  return handle;
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

async function linkCard(handle: string): Promise<void> {
  const link = cardLinks.get(handle);
  if (!link || !store.get().sessions[handle]) return;
  cardLinks.delete(handle);
  await attachChat(handle, link.card, link.name);
  if (link.closeWhenDone && store.get().active !== handle) backgroundChats.add(handle);
  await setUp(handle, link);
}

/** What pi-gna does with a chat it starts itself, once pi is ready: switch its model, then send it a first prompt. */
export interface ChatSetup {
  /** Session name, set with the prompt. */
  name?: string;
  /** For this chat only: pi keeps your default model and thinking level. */
  model?: TaskModel;
  prompt?: string;
  /** Record the chat (say, on a lament) by its session file, before its prompt is sent. */
  link?: (chat: { path: string; cwd: string }) => Promise<unknown>;
}
const setups = new Map<string, ChatSetup>();

async function setUp(handle: string, setup: ChatSetup): Promise<void> {
  if (setup.link) {
    const chat = await sessionFile(handle);
    if (chat) await setup.link(chat);
    else toast("This chat has no session file, so pi-gna cannot link to it", "warning");
  }
  if (setup.model) await useModel(handle, setup.model);
  if (setup.prompt === undefined || !store.get().sessions[handle]) return;
  // Written by pi-gna, not the composer: no attachments or browser comments ride along. Named right away, before
  // pi confirms it, so the sidebar never shows it under another title (or a triage chat at all).
  patchSession(handle, (s) => ({ ...s, prompted: true, name: setup.name ?? s.name }));
  const sent = await command(handle, { type: "prompt", message: setup.prompt });
  if (sent.success && setup.name) await command(handle, { type: "set_session_name", name: setup.name }, true);
  // No run started, so none will settle: tell whoever waits for it (the ATP runner).
  if (!sent.success) settled(handle, "error");
}

/**
 * Start an ATP chat in the background (ATP page): new, or an earlier one from its session file. It never shows in
 * the sidebar; the ATP page opens it.
 */
export function startAtpChat(cwd: string, atp: AtpSession, options: { resume?: { path: string; title: string }; setup?: ChatSetup } = {}): string {
  const handle = start(cwd, options.resume, false, atp);
  if (options.setup) setups.set(handle, options.setup);
  return handle;
}

/** Put a chat on a card, by its session file. */
async function attachChat(handle: string, card: string, label?: string): Promise<void> {
  if (!store.get().sessions[handle]) return;
  const chat = await sessionFile(handle);
  if (chat) await applyBoard({ type: "attach", id: card, chat: { ...chat, label } });
  else toast("This chat has no session file, so it cannot be put on the card", "warning");
}

/** A chat's session file and cwd, which a card or lament keeps to open it. */
async function sessionFile(handle: string): Promise<{ path: string; cwd: string } | undefined> {
  const session = store.get().sessions[handle];
  if (!session) return undefined;
  // Set by the ready event; a new chat's file is named before anything is written to it.
  const path = session.sessionPath ?? (await command<RpcSessionState>(handle, { type: "get_state" }, true)).data?.sessionFile;
  return path ? { path, cwd: session.cwd } : undefined;
}

/** Switch a new chat to a card task's model. For this chat only: pi keeps your default model and thinking level. */
async function useModel(handle: string, want: TaskModel): Promise<void> {
  const model = pickModel(store.get().models, want, store.get().sessions[handle]?.model?.provider);
  if (!model) {
    toast(`${want.provider ? `${want.provider}/` : ""}${want.id} is not available, so this chat runs on your default model`, "warning");
    return;
  }
  await setModel(handle, model);
  await setThinking(handle, want.thinking);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let booted = false;
export function boot(): void {
  if (booted) return;
  booted = true;
  studio().onEvents(handleBatch);
  studio().onAttention(({ chats, removed }) => onAttention(chats, removed));
  store.subscribe(syncViewing);
  void studio()
    .windowFocused()
    .then((focused) => {
      windowFocused = focused;
    });
  studio().onSidebarToggle(toggleSidebar);
  studio().onPageToggle(togglePage);
  studio().onOpenProject(newSession);
  studio().onWindowFocus((focused) => {
    windowFocused = focused;
    syncViewing();
    if (focused && !store.get().page) markRead(store.get().active);
  });
  studio().settings.onChange(onSettings);
  void studio().settings.get().then(onSettings);
  studio().board.onChange((board) => store.set((s) => ({ ...s, board })));
  studio().laments.onChange((laments) => store.set((s) => ({ ...s, laments })));
  void studio()
    .laments.get()
    .then((laments) => store.set((s) => ({ ...s, laments })));
  void studio()
    .board.get()
    .then((board) => store.set((s) => ({ ...s, board })));
  const browser = studio().browser;
  browser.onState((state) => store.set((s) => ({ ...s, browser: state })));
  browser.onReveal(() => setPane({ open: true }));
  browser.onToggle(toggleBrowser);
  browser.onAnnotation((annotation) => store.set((s) => ({ ...s, annotations: [...s.annotations, annotation] })));
  void browser.state().then((state) => state && store.set((s) => ({ ...s, browser: state })));
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

/** Name, else the sidebar's title while loading, else first user message, else "New session". */
export function sessionTitle(session: SessionState): string {
  if (session.name) return session.name;
  if (session.loading) return session.loading.title;
  const first = session.items.find((item) => item.kind === "user");
  if (first?.kind === "user") {
    const content = first.message.content;
    const text = typeof content === "string" ? content : (content.find((block) => block.type === "text") as { text?: string } | undefined)?.text;
    const clean = text ? stripStudioBlocks(text) : "";
    if (clean) return clean.replace(/\s+/g, " ").slice(0, 120);
  }
  return "New session";
}
