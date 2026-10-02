// Contract between the Electron main process and the renderer (exposed as window.studio).
import type { Annotation, BrowserCommand, BrowserLayout, BrowserState, HistoryEntry } from "./browser";
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
  /** Directory pi-studio was launched from; new sessions default to it. */
  launchCwd: string;
  listSessions(): Promise<ProjectGroup[]>;
  openSession(request: OpenSessionRequest): Promise<OpenSessionResult>;
  closeSession(handle: string): Promise<void>;
  command<T = unknown>(handle: string, command: RpcCommand): Promise<RpcResponse<T>>;
  respondUi(handle: string, response: ExtensionUiResponse): void;
  listFiles(cwd: string): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): void;
  onEvents(listener: (batch: HostEventBatch) => void): () => void;
  browser: BrowserApi;
}
