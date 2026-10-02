// Contract between the Electron main process and the renderer (exposed as window.studio).
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
  openProject: "studio:open-project",
} as const;

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
  /** Directory pi studio was launched from (home when opened from Finder); new sessions default to it. */
  launchCwd: string;
  listSessions(): Promise<ProjectGroup[]>;
  openSession(request: OpenSessionRequest): Promise<OpenSessionResult>;
  closeSession(handle: string): Promise<void>;
  command<T = unknown>(handle: string, command: RpcCommand): Promise<RpcResponse<T>>;
  respondUi(handle: string, response: ExtensionUiResponse): void;
  listFiles(cwd: string): Promise<string[]>;
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
  /** Another launch (say `pi --studio` in a different project) asks for a new chat in `cwd`. */
  onOpenProject(listener: (cwd: string) => void): () => void;
  /** Absolute path of a dropped or pasted File ("" for in-memory data such as a copied screenshot). */
  pathForFile(file: File): string;
  openExternal(url: string): void;
  onEvents(listener: (batch: HostEventBatch) => void): () => void;
  browser: BrowserApi;
}
