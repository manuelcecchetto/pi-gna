// Contract between the Electron main process and the renderer (exposed as window.studio).
import type { AtpPlan, AtpProjectPlans, AtpSession } from "./atp";
import type { Board, BoardOp, Column } from "./board";
import type { AuthMethod, AuthState, LoginResult, LoginUpdate } from "./auth";
import type { Annotation, BrowserCommand, BrowserLayout, BrowserState, HistoryEntry } from "./browser";
import type { ViewportRequest, ViewportSpec } from "./viewport";
import type { CompactionSettings } from "./compaction";
import type { GithubFilter, GithubKind, GithubList, GithubLookup, GithubProject } from "./github";
import type { ComputerOp, ComputerSettings, Permissions } from "./computer";
import type { LamentOp, Laments } from "./laments";
import type { PiPatch, PiSettingsState } from "./pi-settings";
import type { AtpPlanThreads, AtpRunnerState, AttentionSummary, ChatSnapshot, HostErrorCode, HostEvent, NewCardAttachment, QueueEdit, Revved, TaskStarted, TaskTarget } from "./host-api";
import type { Settings, SettingsOp, SettingsSection } from "./settings";
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
  detachSession: "studio:detach-session",
  attachSession: "studio:attach-session",
  viewing: "studio:viewing",
  liveChats: "studio:live-chats",
  attention: "studio:attention",
  interrupt: "studio:interrupt",
  editQueue: "studio:edit-queue",
  command: "studio:command",
  respondDialog: "studio:respond-dialog",
  listFiles: "studio:list-files",
  pickFolder: "studio:pick-folder",
  pickAttachments: "studio:pick-attachments",
  describePaths: "studio:describe-paths",
  compactionSettings: "studio:compaction-settings",
  windowFocused: "studio:window-focused",
  windowFocus: "studio:window-focus",
  openExternal: "studio:open-external",
  visualKill: "studio:visual-kill",
  events: "studio:events",
  browserLayout: "browser:layout",
  browserNewTab: "browser:new-tab",
  browserCloseTab: "browser:close-tab",
  browserActivate: "browser:activate",
  browserNavigate: "browser:navigate",
  browserCommand: "browser:command",
  browserAnnotate: "browser:annotate",
  browserInspect: "browser:inspect",
  browserViewport: "browser:viewport",
  browserPopOut: "browser:pop-out",
  browserReturn: "browser:return",
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
  lamentsGet: "laments:get",
  lamentsApply: "laments:apply",
  lamentsChanged: "laments:changed",
  computerGet: "computer:get",
  computerApply: "computer:apply",
  computerChanged: "computer:changed",
  computerPermissions: "computer:permissions",
  computerRequest: "computer:request",
  computerOpenSettings: "computer:open-settings",
  settingsGet: "settings:get",
  settingsApply: "settings:apply",
  settingsChanged: "settings:changed",
  piSettingsGet: "settings:pi-get",
  piSettingsApply: "settings:pi-apply",
  piSettingsReveal: "settings:pi-reveal",
  authList: "auth:list",
  authLogin: "auth:login",
  authUpdate: "auth:update",
  authAnswer: "auth:answer",
  authCancel: "auth:cancel",
  authLogout: "auth:logout",
  boardSaveImage: "board:save-image",
  githubProject: "github:project",
  githubChoose: "github:choose",
  githubList: "github:list",
  githubLookup: "github:lookup",
  atpWatch: "atp:watch",
  atpPlans: "atp:plans",
  atpRead: "atp:read",
  atpHeld: "atp:held",
  atpRunners: "atp:runners",
  atpThreadsChanged: "atp:threads-changed",
  atpState: "atp:state",
  atpStart: "atp:start",
  atpStop: "atp:stop",
  atpReleaseInterrupted: "atp:release-interrupted",
  atpLiftHold: "atp:lift-hold",
  atpThreads: "atp:threads",
  atpOrchestrator: "atp:orchestrator",
  atpReleaseOrchestrators: "atp:release-orchestrators",
  atpDiscardNewPlan: "atp:discard-new-plan",
  atpImportThreads: "atp:import-threads",
  startTask: "studio:start-task",
  addCard: "studio:add-card",
  updateGet: "update:get",
  updateState: "update:state",
  updateDownload: "update:download",
  updateReveal: "update:reveal",
} as const;

/** The Computer Use policy lives in main; every change is pushed back. */
export interface ComputerApi {
  get(): Promise<Revved<ComputerSettings>>;
  /** Rejects with the reason for an invalid op. */
  apply(op: ComputerOp, baseRev?: number): Promise<Revved<ComputerSettings>>;
  onChange(listener: (settings: Revved<ComputerSettings>) => void): () => void;
  /** Live Accessibility and Screen Recording status from the helper (starts it); rejects with the reason it cannot. */
  permissions(): Promise<Permissions>;
  /** Ask macOS for the missing permissions (shows its prompts), then report the status. */
  /** Prompts for what is missing; for Screen Recording, which macOS will not prompt for, opens the pane and shows the helper. */
  requestPermissions(pane?: "accessibility" | "screen_recording"): Promise<Permissions>;
  openSettings(pane: "accessibility" | "screen_recording"): Promise<void>;
}

/** Full-window pages shown instead of a chat. */
export type Page = "kanban" | "laments" | "github" | "atp" | "settings";

/** pi-gna's own settings live in main (userData/settings.json); every change is pushed back. pi's settings are pi's
 * settings.json, which main reads and writes for the Settings page. */
export interface SettingsApi {
  get(): Promise<Revved<Settings>>;
  /** Rejects with the reason for an invalid op. */
  apply(op: SettingsOp, baseRev?: number): Promise<Revved<Settings>>;
  onChange(listener: (settings: Revved<Settings>) => void): () => void;
  /** The keys of pi's settings.json the Settings page edits (src/shared/pi-settings.ts). */
  pi(): Promise<PiSettingsState>;
  /** Change them for new chats; rejects when the file is not valid JSON or the change is not valid. */
  setPi(patch: PiPatch): Promise<PiSettingsState>;
  /** Show pi's settings.json in the Finder. */
  revealPi(): Promise<void>;
}

/** pi's provider logins, which main runs with pi's own SDK (src/main/pi-auth.ts). One login at a time. */
export interface AuthApi {
  /** pi's providers and how each is signed in; `error` when pi-gna cannot reach pi's logins. */
  list(): Promise<AuthState>;
  /** Runs a login to its end; a new one cancels the last. Its prompts and events arrive through onUpdate, and main
   * opens the sign-in page in the browser, as pi's /login does. */
  login(provider: string, method: AuthMethod): Promise<LoginResult>;
  onUpdate(listener: (update: LoginUpdate) => void): () => void;
  /** The answer to prompt `n` of the running login. */
  answer(n: number, value: string): void;
  cancel(): void;
  /** Removes the credential pi saved in auth.json. */
  logout(provider: string): Promise<void>;
}

/** The laments live in main, which agents file them with; every change is pushed back. */
export interface LamentsApi {
  get(): Promise<Revved<Laments>>;
  /** Rejects with the reason for an invalid op (unknown lament). */
  apply(op: LamentOp, baseRev?: number): Promise<Revved<Laments>>;
  onChange(listener: (laments: Revved<Laments>) => void): () => void;
}

/** The Kanban boards live in main, which agents change too; every change is pushed back. */
export interface BoardApi {
  get(): Promise<Revved<Board>>;
  /** Rejects with the reason for an invalid op (unknown card, title too long). */
  apply(op: BoardOp, baseRev?: number): Promise<Revved<Board>>;
  onChange(listener: (board: Revved<Board>) => void): () => void;
  /** Save an image for a card that was just added (AddCard) and return its path; deleted with the card. */
  saveImage(card: string, image: { mimeType: string; data: string }): Promise<string>;
}

/**
 * A project's GitHub issues and pull requests, read with gh in main as the account that can see the project's
 * repository (src/main/github.ts). What is in the way (no gh, no remote, no account) comes back as a `problem`.
 */
export interface GithubApi {
  /** The project's repository and the account used for it; `refresh` asks gh for its accounts again. */
  project(cwd: string, refresh?: boolean): Promise<GithubProject>;
  /** Use this account for the project from now on, or let pi-gna pick it again (null). */
  choose(cwd: string, login: string | null): Promise<GithubProject>;
  list(cwd: string, kind: GithubKind, filter: GithubFilter): Promise<GithubList>;
  /** An issue or pull request of the project's repository, from "#12" or its link, as a card's link. */
  lookup(cwd: string, input: string): Promise<GithubLookup>;
}

/**
 * ATP plans (src/shared/atp.ts): main finds a project's `*.atp.json` files and pushes them as they change, and runs
 * them (src/main/atp-runner.ts): the runner claims nodes with the librarian CLI, starts the worker chats, commits after
 * each node, and keeps the orchestrator chats and the plans' threads. The page is a view of that state.
 */
export interface AtpApi {
  /** The project's plans, pushed again (onPlans) whenever one changes, until another project is watched (or null). */
  watch(cwd: string | null): Promise<AtpProjectPlans | null>;
  onPlans(listener: (plans: AtpProjectPlans) => void): () => void;
  read(plan: string): Promise<AtpPlan>;
  /** Runs, run notes and orchestrator chats, and the plans an orchestrator paused (atp_pause: the runner claims none of their nodes). */
  state(): Promise<AtpRunnerState & { held: string[] }>;
  onRunners(listener: (state: AtpRunnerState) => void): () => void;
  onHeld(listener: (plans: string[]) => void): () => void;
  /** Run the plan in the project (activating it); also resumes a stopped plan. The run goes on in main, window or not. */
  start(plan: string, cwd: string): Promise<null>;
  /** Abort the plan's worker; its node goes back to READY. */
  stop(plan: string): Promise<null>;
  /** Give back a node a run that ended without it still holds. */
  releaseInterrupted(plan: string, node: string): Promise<null>;
  /** Let the runner claim nodes of a plan its orchestrator paused. */
  liftHold(plan: string): Promise<null>;
  /** The chats that worked on a plan, pushed again (onThreads) when they change. */
  threads(plan: string): Promise<AtpPlanThreads>;
  onThreads(listener: (change: { plan: string; threads: AtpPlanThreads }) => void): () => void;
  /** The plan's orchestrator chat, started or resumed; without a plan, a chat for one the architect is about to write. The window attaches to it. */
  orchestrator(cwd: string, plan?: string): Promise<{ handle: string }>;
  /** The page closed: idle orchestrators stop, busy ones when they finish. */
  releaseOrchestrators(): Promise<null>;
  discardNewPlan(cwd: string): Promise<null>;
  /** The threads this window kept in localStorage before they lived in main; merged once. */
  importThreads(threads: unknown): Promise<null>;
}

/** The git worktree a card's Resolve chat, or a lament's Fix chat, works in, on a branch of its own (src/main/worktree.ts). */
export interface CardWorktree {
  /** Where the chat runs: the project's folder in the worktree (worktreeCwd). */
  cwd: string;
  branch: string;
  /** Made now, not left from an earlier Resolve of the card. */
  created: boolean;
  /** The checkout has uncommitted changes, which the worktree does not have. */
  dirty: boolean;
}

/** A pi-gna release newer than the running one (GitHub's latest release). */
export interface UpdateRelease {
  version: string;
  /** Markdown: the version's CHANGELOG.md section, then GitHub's generated notes. */
  notes: string;
  /** The release page, which also has the dmgs. */
  url: string;
  publishedAt: string;
}

/**
 * pi-gna checks GitHub for a newer release (packaged builds, at launch and every few hours) and installs it
 * itself: download, verify, stage, then swap when it quits (docs/DESIGN.md, Updates).
 */
export type UpdateState =
  | { phase: "idle" }
  /** `manual`: why pi-gna cannot install it itself (say a read-only location); the release page can. */
  | { phase: "available"; release: UpdateRelease; manual?: string }
  /** `progress` 0..1; 1 while the downloaded app is unpacked and checked. */
  | { phase: "downloading"; release: UpdateRelease; progress: number }
  /** Staged: installs when pi-gna quits, or now with `relaunch()`. */
  | { phase: "ready"; release: UpdateRelease }
  | { phase: "failed"; release: UpdateRelease; error: string };

export interface UpdateApi {
  state(): Promise<UpdateState>;
  onState(listener: (state: UpdateState) => void): () => void;
  /** Download, verify and stage the available release. */
  download(): Promise<void>;
  /** pi-gna > Check for Updates… found one: show it. */
  onReveal(listener: () => void): () => void;
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
  /** Set a tab's emulated viewport (resolved through resolveViewport) or reset it with null. Rejects invalid input. */
  viewport(id: string, request: ViewportRequest | null): Promise<ViewportSpec | null>;
  /** Move a pane tab into its own window. Rejects at the window limit. */
  popOut(id: string): Promise<void>;
  /** Move a window tab back into the pane. */
  returnToPane(id: string): Promise<void>;
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
  /** Desktop-chosen handle, honored while the renderer still picks its own; omit to get one issued by the host. */
  handle?: string;
  cwd: string;
  /** Existing session file; omit to start a new session in `cwd`. */
  sessionPath?: string;
  /** An ATP worker or orchestrator: its own session folder, skills and prompt. */
  atp?: AtpSession;
}

export interface OpenSessionResult {
  /** The chat's handle: the one asked for, the host's own, or the live chat's when the file was already open. */
  handle: string;
  /** The file was already live: this joined its chat instead of spawning pi. */
  reused?: boolean;
  /** Active branch of the session file (root -> leaf), empty for new sessions. */
  entries: SessionEntry[];
}

/** Everything the main process pushes to the renderer for one session handle (src/shared/host-api.ts). */
export type { HostEvent };

export interface HostEventBatch {
  handle: string;
  events: HostEvent[];
  /** The host `seq` of the batch's last event; an attach snapshot reflects every event up to its own `seq`. */
  seq?: number;
}

/** What `respondDialog` answers: the card goes on `ok`, or when the dialog was settled elsewhere first. */
export type DialogAnswer = { ok: true } | { ok: false; code: HostErrorCode; message: string };

export interface StudioApi {
  homeDir: string;
  /** Directory pi-gna was launched from (home when opened from Finder); new sessions default to it. */
  launchCwd: string;
  /**
   * This page is a newer build than the running main process: a checkout's `out/` was rebuilt and the window
   * reloaded. Calls into main can fail (say "No handler registered") until pi-gna restarts.
   */
  stale: boolean;
  /** The running pi-gna's version (package.json, `app.getVersion()`), as in the About panel. */
  version: string;
  /** Quit and start pi-gna again from the build on disk, or as the staged update; running chats stop. */
  relaunch(): Promise<void>;
  listSessions(): Promise<ProjectGroup[]>;
  openSession(request: OpenSessionRequest): Promise<OpenSessionResult>;
  /** Stop the chat's pi (explicit "Close chat"; also tells other clients). */
  closeSession(handle: string): Promise<void>;
  /** Leave a chat without stopping it: pi stops only if nobody else holds it and it is disposable. */
  detachSession(handle: string): Promise<void>;
  /** Join a live chat (one another client started, or one this window had before a reload); null when it ended. */
  attachSession(handle: string): Promise<(ChatSnapshot & { seq: number }) | null>;
  /** This window shows (or stops showing) the chat in the foreground. */
  viewing(handle: string, viewing: boolean): void;
  /** Attention summaries of every live chat. */
  liveChats(): Promise<AttentionSummary[]>;
  onAttention(listener: (update: { chats: AttentionSummary[]; removed: string[] }) => void): () => void;
  /** Esc/Stop: take the queued messages back (returned), then abort. */
  interrupt(handle: string): Promise<string[]>;
  editQueue(handle: string, op: QueueEdit): Promise<boolean>;
  command<T = unknown>(handle: string, command: RpcCommand): Promise<RpcResponse<T>>;
  respondDialog(handle: string, response: ExtensionUiResponse): Promise<DialogAnswer>;
  listFiles(cwd: string): Promise<string[]>;
  /**
   * Start the chat for a task (a card's investigation, resolution or QA, a lament's fix, a pull request's review) and
   * join it: main makes the git worktree, links the chat to the card or lament, sends its prompt and names it. Rejects
   * when the worktree cannot be made.
   */
  startTask(target: TaskTarget): Promise<TaskStarted>;
  /**
   * Add a card from one description and what you attached; main saves the images, lists them in the notes and starts
   * the card's triage chat in the background. Rejects (after removing the card) when an attachment cannot be saved.
   */
  addCard(cwd: string, column: Column, description: string, attachments?: NewCardAttachment[]): Promise<{ id: string }>;
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
  /** View > Kanban (⌘⇧K), Laments (⌘⇧L), GitHub (⌘⇧G), ATP (⌘⇧A), pi-gna > Settings… (⌘,) and View > Computer Use
   * (⌘⇧U, Settings at that section): page toggles from the menu. */
  onPageToggle(listener: (page: Page, section?: SettingsSection) => void): () => void;
  /** Another launch (say `pi --pigna` in a different project) asks for a new chat in `cwd`. */
  onOpenProject(listener: (cwd: string) => void): () => void;
  /** Absolute path of a dropped or pasted File ("" for in-memory data such as a copied screenshot). */
  pathForFile(file: File): string;
  openExternal(url: string): void;
  /** Kill the renderer process of a stuck inline visual frame (by its id), so a runaway script stops burning a core. */
  killVisual(frameId: string): void;
  onEvents(listener: (batch: HostEventBatch) => void): () => void;
  browser: BrowserApi;
  board: BoardApi;
  laments: LamentsApi;
  computer: ComputerApi;
  settings: SettingsApi;
  auth: AuthApi;
  github: GithubApi;
  atp: AtpApi;
  update: UpdateApi;
}
