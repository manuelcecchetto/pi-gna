// Contract between the Electron main process and the renderer (exposed as window.studio).
import type { Board, BoardOp } from "./board";
import type { Annotation, BrowserCommand, BrowserLayout, BrowserState, HistoryEntry } from "./browser";
import type { CompactionSettings } from "./compaction";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  SessionEntry,
  SessionEvent,
} from "./protocol";

export const IPC = {
  listSessions: "studio:list-sessions",
  openSession: "studio:open-session",
  closeSession: "studio:close-session",
  command: "studio:command",
  respondUi: "studio:respond-ui",
  listFiles: "studio:list-files",
  pickFolder: "studio:pick-folder",
  pickAttachments: "studio:pick-attachments",
  describePaths: "studio:describe-paths",
  compactionSettings: "studio:compaction-settings",
  windowFocused: "studio:window-focused",
  windowFocus: "studio:window-focus",
  openExternal: "studio:open-external",
  events: "studio:events",
  browserLayout: "browser:layout",
  browserNewTab: "browser:new-tab",
  browserCloseTab: "browser:close-tab",
  browserActivate: "browser:activate",
  browserNavigate: "browser:navigate",
  browserCommand: "browser:command",
  browserAnnotate: "browser:annotate",
  browserInspect: "browser:inspect",
  browserHistory: "browser:history",
  browserGetState: "browser:get-state",
  browserState: "browser:state",
  browserReveal: "browser:reveal",
  browserAnnotation: "browser:annotation",
  browserToggle: "browser:toggle",
  sidebarToggle: "studio:sidebar-toggle",
  pageToggle: "studio:page-toggle",
  openProject: "studio:open-project",
  relaunch: "studio:relaunch",
  boardGet: "board:get",
  boardApply: "board:apply",
  boardChanged: "board:changed",
  boardSaveImage: "board:save-image",
  cardWorktree: "studio:card-worktree",
} as const;

/** Full-window pages shown instead of a chat. */
export type Page = "kanban";

/** The Kanban boards live in main, which agents change too; every change is pushed back. */
export interface BoardApi {
  get(): Promise<Board>;
  /** Rejects with the reason for an invalid op (unknown card, title too long). */
  apply(op: BoardOp): Promise<Board>;
  onChange(listener: (board: Board) => void): () => void;
  /** Save an image for a card that was just added (AddCard) and return its path; deleted with the card. */
  saveImage(card: string, image: { mimeType: string; data: string }): Promise<string>;
}

/** The git worktree a card's Resolve chat works in, on a branch of its own (src/main/worktree.ts). */
export interface CardWorktree {
  /** Where the chat runs: the project's folder in the worktree (worktreeCwd). */
  cwd: string;
  branch: string;
  /** Made now, not left from an earlier Resolve of the card. */
  created: boolean;
  /** The checkout has uncommitted changes, which the worktree does not have. */
  dirty: boolean;
}

export interface BrowserApi {
  layout(layout: BrowserLayout): void;
  newTab(url?: string): void;
  closeTab(id: string): void;
  activate(id: string): void;
  navigate(id: string, input: string): void;
  command(id: string, command: BrowserCommand): void;
  annotate(on: boolean): void;
  inspect(id: string): void;
  history(): Promise<HistoryEntry[]>;
  state(): Promise<BrowserState>;
  onState(listener: (state: BrowserState) => void): () => void;
  onReveal(listener: () => void): () => void;
  onAnnotation(listener: (annotation: Annotation) => void): () => void;
  /** View > Toggle Browser (a menu accelerator, so it works while a page has focus). */
  onToggle(listener: () => void): () => void;
}

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  title: string;
  named: boolean;
  createdAt: number;
  modifiedAt: number;
}

export interface ProjectGroup {
  cwd: string;
  modifiedAt: number;
  sessions: SessionSummary[];
}

/** A path the user attached; images include their bytes. */
export interface PickedPath {
  path: string;
  name: string;
  isDir: boolean;
  image?: { mimeType: string; data: string };
}

export interface OpenSessionRequest {
  /** Renderer-chosen handle, so events can never arrive for an unknown session. */
  handle: string;
  cwd: string;
  /** Existing session file; omit to start a new session in `cwd`. */
  sessionPath?: string;
}

export interface OpenSessionResult {
  /** Active branch of the session file (root -> leaf), empty for new sessions. */
  entries: SessionEntry[];
}

/** Everything the main process pushes to the renderer for one session handle. */
export type HostEvent =
  | { kind: "rpc"; record: SessionEvent | ExtensionUiRequest }
  | { kind: "ready"; state: RpcSessionState }
  | { kind: "exit"; code: number | null; signal: string | null; error?: string; stderrTail: string };

export interface HostEventBatch {
  handle: string;
  events: HostEvent[];
}

export interface StudioApi {
  homeDir: string;
  /** Directory pi-gna was launched from (home when opened from Finder); new sessions default to it. */
  launchCwd: string;
  /**
   * This page is a newer build than the running main process: a checkout's `out/` was rebuilt and the window
   * reloaded. Calls into main can fail (say "No handler registered") until pi-gna restarts.
   */
  stale: boolean;
  /** Quit and start pi-gna again from the build on disk; running chats stop. */
  relaunch(): Promise<void>;
  listSessions(): Promise<ProjectGroup[]>;
  openSession(request: OpenSessionRequest): Promise<OpenSessionResult>;
  closeSession(handle: string): Promise<void>;
  command<T = unknown>(handle: string, command: RpcCommand): Promise<RpcResponse<T>>;
  respondUi(handle: string, response: ExtensionUiResponse): void;
  listFiles(cwd: string): Promise<string[]>;
  /**
   * The git worktree to resolve a card in: made on first use, then reused. Null when the card's project is not in a
   * git repository; rejects when git fails.
   */
  cardWorktree(card: string): Promise<CardWorktree | null>;
  pickFolder(): Promise<string | null>;
  /** Native picker: "photos" for images, "files" for files and folders. */
  pickAttachments(kind: "photos" | "files"): Promise<PickedPath[]>;
  describePaths(paths: string[]): Promise<PickedPath[]>;
  /** pi's global compaction settings (reserveTokens and per-model overrides), for the context meter. */
  compactionSettings(): Promise<CompactionSettings>;
  /**
   * Whether the app window is focused. Not document.hasFocus(): that is also false while you use the
   * browser pane (a separate web view), which still counts as looking at the window.
   */
  windowFocused(): Promise<boolean>;
  onWindowFocus(listener: (focused: boolean) => void): () => void;
  /** View > Toggle Sidebar (⌘⇧S). */
  onSidebarToggle(listener: () => void): () => void;
  /** View > Kanban (⌘⇧K): page toggles from the menu. */
  onPageToggle(listener: (page: Page) => void): () => void;
  /** Another launch (say `pi --pigna` in a different project) asks for a new chat in `cwd`. */
  onOpenProject(listener: (cwd: string) => void): () => void;
  /** Absolute path of a dropped or pasted File ("" for in-memory data such as a copied screenshot). */
  pathForFile(file: File): string;
  openExternal(url: string): void;
  onEvents(listener: (batch: HostEventBatch) => void): () => void;
  browser: BrowserApi;
  board: BoardApi;
}
