// App state and actions. Session state transitions live in lib/session.ts (pure); this module
// owns side effects: IPC calls, toasts, lifecycle of pi processes, and project refreshes.
import type { Annotation, BrowserState } from "../../../shared/browser";
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
import { loadSidebar, type SidebarLayout, saveSidebar } from "../lib/layout";
import { applyQueueOp, type QueueOp, type Queues } from "../lib/queue";
import { createSession, hydrate, isDisposable, isDraft, reduceHostEvent, runOutcome, type SessionState } from "../lib/session";
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
  sidebar: SidebarLayout;
  /** pi's compaction settings, for the context meter's auto-compaction point. */
  compaction: CompactionSettings;
  /** Full-size image overlay (data URL). Hides the native browser view while open. */
  lightbox?: string;
  /** A DOM dialog or menu is open over the page; it hides the native browser view, which would cover it. */
  overlay: boolean;
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
  compaction: {},
  sidebar: loadSidebar(),
  overlay: false,
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

function newHandle(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

export function openSession(summary: SessionSummary): void {
  const existing = Object.values(store.get().sessions).find((s) => s.sessionPath === summary.path);
  if (existing) return activate(existing.handle);
  void start(summary.cwd, summary);
}

export function newSession(cwd: string): void {
  const { active, sessions } = store.get();
  const current = active ? sessions[active] : undefined;
  if (current && current.cwd === cwd && current.phase !== "exited" && isDraft(current)) {
    prefill(current.handle, ""); // already in an empty chat here: just focus its composer
    return;
  }
  void start(cwd);
}

async function start(cwd: string, summary?: SessionSummary): Promise<void> {
  const handle = newHandle();
  const sessionPath = summary?.path;
  // It is shown right away, so it must not look like an empty new chat until its history arrives.
  const session: SessionState = { ...createSession(handle, cwd, sessionPath), loading: summary && { title: summary.title } };
  store.set((state) => ({ ...state, sessions: { ...state.sessions, [handle]: session }, open: [...state.open, handle] }));
  activate(handle);
  try {
    const { entries } = await studio().openSession({ handle, cwd, sessionPath });
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

/** You are looking at this chat: clear its unread mark. */
function markRead(handle: string | undefined): void {
  if (handle && store.get().sessions[handle]?.unread) patchSession(handle, (s) => ({ ...s, unread: undefined }));
}

export function activate(handle: string | undefined): void {
  const previous = store.get().active;
  markRead(handle);
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
      // Finished while you were not looking: another chat was open, or the window was in the background.
      if (store.get().active !== handle || !windowFocused) patchSession(handle, (s) => ({ ...s, unread: runOutcome(s.items) }));
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
  const message = [text, formatAnnotations(annotations), formatFileMentions(attachments)].filter(Boolean).join("\n\n");
  const images: ImageContent[] = [
    ...attachmentImages(attachments),
    ...annotations.flatMap((a) => (a.image ? [{ type: "image" as const, data: a.image, mimeType: "image/jpeg" }] : [])),
  ];
  const cmd: RpcCommand = { type: "prompt", message, images: images.length ? images : undefined };
  if (session.running && !isCommand) cmd.streamingBehavior = mode === "followUp" ? "followUp" : "steer";
  patchSession(handle, (s) => ({ ...s, prompted: true }));
  const response = await command<{ disposition: string }>(handle, cmd);
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
  addAttachments(handle, (await studio().pickAttachments(kind)).map(fromPicked));
}

/**
 * Dropped or pasted Files: anything with a path (Finder files and folders) is described by main;
 * in-memory images (a screenshot copied to the clipboard) are read right away, since clipboard
 * data does not outlive the event.
 */
export async function attachFiles(handle: string, files: File[]): Promise<void> {
  const paths: string[] = [];
  const pending: Promise<Attachment>[] = [];
  for (const file of files) {
    const path = studio().pathForFile(file);
    if (path) paths.push(path);
    else if (file.type.startsWith("image/")) pending.push(readImage(file));
  }
  const [described, images] = await Promise.all([paths.length ? studio().describePaths(paths) : [], Promise.all(pending)]);
  addAttachments(handle, [...described.map(fromPicked), ...images]);
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
  newSession((active && sessions[active]?.cwd) || studio().launchCwd || studio().homeDir);
}

export function openLightbox(src: string | undefined): void {
  store.set((s) => ({ ...s, lightbox: src }));
}

/**
 * Edit pi's queues (trash, steer now, defer, take out to edit). RPC can only clear both queues and append,
 * so this clears, applies the op and re-queues the rest in order. Images on re-queued messages are lost.
 */
export async function editQueue(handle: string, op: QueueOp): Promise<boolean> {
  if (!store.get().sessions[handle]?.running) return false;
  const cleared = await command<Queues>(handle, { type: "clear_queue" }, true);
  if (!cleared.data) return false;
  const { queues, found } = applyQueueOp(cleared.data, op);
  for (const message of queues.steering) await command(handle, { type: "steer", message });
  for (const message of queues.followUp) await command(handle, { type: "follow_up", message });
  return found;
}

/** Esc: restore queued messages, then abort the agent run or manual compaction. */
export async function interrupt(handle: string): Promise<string[]> {
  const session = store.get().sessions[handle];
  if (!session || (!session.running && !session.compacting)) return [];
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

/** Put text in a session's composer (suggestions, like an extension's set_editor_text). */
export function prefill(handle: string, text: string): void {
  patchSession(handle, (s) => ({ ...s, editorText: { text, nonce: Date.now() } }));
}

export function setExpanded(key: string, open: boolean): void {
  store.set((state) => ({ ...state, expanded: { ...state.expanded, [key]: open } }));
}

export function setOverlay(overlay: boolean): void {
  store.set((s) => (s.overlay === overlay ? s : { ...s, overlay }));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let booted = false;
export function boot(): void {
  if (booted) return;
  booted = true;
  studio().onEvents(handleBatch);
  void studio()
    .windowFocused()
    .then((focused) => {
      windowFocused = focused;
    });
  studio().onSidebarToggle(toggleSidebar);
  studio().onOpenProject(newSession);
  studio().onWindowFocus((focused) => {
    windowFocused = focused;
    if (focused) markRead(store.get().active);
  });
  const browser = studio().browser;
  browser.onState((state) => store.set((s) => ({ ...s, browser: state })));
  browser.onReveal(() => setPane({ open: true }));
  browser.onToggle(toggleBrowser);
  browser.onAnnotation((annotation) => store.set((s) => ({ ...s, annotations: [...s.annotations, annotation] })));
  void browser.state().then((state) => state && store.set((s) => ({ ...s, browser: state })));
  void studio()
    .compactionSettings()
    .then((compaction) => store.set((s) => ({ ...s, compaction })));
  refreshProjects();
  newSession(studio().launchCwd || studio().homeDir);
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
