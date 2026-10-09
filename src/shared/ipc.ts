// Contract between the Electron main process and the renderer (exposed as window.studio).
import type { AtpPlan, AtpProjectPlans, AtpSession } from "./atp";
import type { Board, BoardOp, Column } from "./board";
import type { AuthMethod, AuthState, LoginResult, LoginUpdate } from "./auth";
import type { CatalogState, McpLoginResult, McpLoginUpdate, McpStatusState, PackageToggle, PluginsState, PluginToggle } from "./plugins";
import type { PreviewMode, PreviewOpenOptions } from "./preview";
import type { Annotation, BrowserCommand, BrowserLayout, BrowserState, HistoryEntry } from "./browser";
import type { ViewportRequest, ViewportSpec } from "./viewport";
import type { CompactionSettings } from "./compaction";
import type { GithubFilter, GithubKind, GithubList, GithubLookup, GithubProject } from "./github";
import type { ComputerOp, ComputerSettings, Permissions } from "./computer";
import type { LamentOp, Laments } from "./laments";
import type { ThemeOp, Themes } from "./themes";
import type { PiPatch, PiSettingsState } from "./pi-settings";
import type { SetupInstallResult, SetupStatus } from "./setup";
import type { AtpPlanThreads, AtpRunnerState, AttentionSummary, ChatSnapshot, DeviceInfo, HostErrorCode, HostEvent, NewCardAttachment, PairingStatus, QueueEdit, RemoteStatus, Revved, TaskStarted, TaskTarget, UiState } from "./host-api";
import type { Settings, SettingsOp, SettingsSection } from "./settings";
import type { UiOp } from "./ui-state";
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
  pageSession: "studio:page-session",
  viewing: "studio:viewing",
  shown: "studio:shown",
  liveChats: "studio:live-chats",
  attention: "studio:attention",
  sessionIndexed: "studio:session-indexed",
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
  browserStill: "browser:still",
  browserFocus: "browser:focus",
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
  browserPreview: "browser:preview",
  browserCard: "browser:card",
  browserPreviewMode: "browser:preview-mode",
  browserPreviewReveal: "browser:preview-reveal",
  browserPreviewOpen: "browser:preview-open",
  browserResolveTargets: "browser:resolve-targets",
  browserReadImage: "browser:read-image",
  browserSiteIcon: "browser:site-icon",
  sidebarToggle: "studio:sidebar-toggle",
  paletteToggle: "studio:palette-toggle",
  pageToggle: "studio:page-toggle",
  openProject: "studio:open-project",
  relaunch: "studio:relaunch",
  boardGet: "board:get",
  boardApply: "board:apply",
  boardChanged: "board:changed",
  lamentsGet: "laments:get",
  lamentsApply: "laments:apply",
  lamentsChanged: "laments:changed",
  themesGet: "themes:get",
  themesApply: "themes:apply",
  themesChanged: "themes:changed",
  themesImage: "themes:image",
  themesActive: "themes:active",
  computerGet: "computer:get",
  computerApply: "computer:apply",
  computerChanged: "computer:changed",
  computerPermissions: "computer:permissions",
  computerRequest: "computer:request",
  computerOpenSettings: "computer:open-settings",
  settingsGet: "settings:get",
  settingsApply: "settings:apply",
  settingsChanged: "settings:changed",
  uiGet: "ui:get",
  uiApply: "ui:apply",
  uiChanged: "ui:changed",
  uiImportLegacy: "ui:import-legacy",
  piSettingsGet: "settings:pi-get",
  piSettingsApply: "settings:pi-apply",
  piSettingsReveal: "settings:pi-reveal",
  authList: "auth:list",
  authLogin: "auth:login",
  authUpdate: "auth:update",
  authAnswer: "auth:answer",
  authCancel: "auth:cancel",
  authLogout: "auth:logout",
  pluginsCatalog: "plugins:catalog",
  pluginsState: "plugins:state",
  pluginsStatus: "plugins:status",
  pluginsToggle: "plugins:toggle",
  pluginsTogglePackage: "plugins:toggle-package",
  pluginsInstall: "plugins:install",
  pluginsRemove: "plugins:remove",
  pluginsConnect: "plugins:connect",
  pluginsDisconnect: "plugins:disconnect",
  pluginsEnableServer: "plugins:enable-server",
  pluginsLogin: "plugins:login",
  pluginsLoginUpdate: "plugins:login-update",
  pluginsCancelLogin: "plugins:cancel-login",
  pluginsLogout: "plugins:logout",
  setupStatus: "setup:status",
  setupInstallPi: "setup:install-pi",
  setupLine: "setup:line",
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
  remoteGet: "remote:get",
  remoteChanged: "remote:changed",
  remoteEnable: "remote:enable",
  remoteDisable: "remote:disable",
  remoteServe: "remote:serve",
  remoteUnserve: "remote:unserve",
  devicesList: "devices:list",
  devicesChanged: "devices:changed",
  devicesRevoke: "devices:revoke",
  devicesRevokeAll: "devices:revoke-all",
  pairStart: "devices:pair-start",
  pairing: "devices:pairing",
  pairDecide: "devices:pair-decide",
  pairingChanged: "devices:pairing-changed",
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

/** Pinned projects and bookmarked turns live in main, the same for every client; every change is pushed back. */
export interface UiApi {
  get(): Promise<Revved<UiState>>;
  apply(op: UiOp, baseRev?: number): Promise<Revved<UiState>>;
  onChange(listener: (ui: Revved<UiState>) => void): () => void;
  /** Hand over the window's old localStorage copies (merged, not replaced). */
  importLegacy(ui: unknown): Promise<null>;
}

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

/** The Plugins section (src/main/plugins.ts): pi's packages, resources and MCP servers, changed in pi's own files.
 * `cwd` is the project of the page, for its view and its .pi files; absent outside a project. Desktop only. */
export interface PluginsApi {
  catalog(): Promise<CatalogState>;
  state(cwd?: string): Promise<PluginsState>;
  /** `pi mcp list`: connects to every enabled server, so it takes a second or so. */
  status(cwd?: string): Promise<McpStatusState>;
  toggle(cwd: string | undefined, toggle: PluginToggle): Promise<void>;
  togglePackage(cwd: string | undefined, toggle: PackageToggle): Promise<void>;
  /** A catalog package by its id, into your personal settings. */
  install(id: string): Promise<void>;
  remove(cwd: string | undefined, source: string, scope: "user" | "project"): Promise<void>;
  /** A catalog connection by its id, at one of its endpoints; `token` for one that signs in with a key. */
  connect(id: string, endpoint: string, token?: string): Promise<void>;
  disconnect(cwd: string | undefined, server: string, scope: "global" | "project"): Promise<void>;
  enableServer(cwd: string | undefined, server: string, scope: "global" | "project", enabled: boolean): Promise<void>;
  /** `pi mcp login`, to its end; pi opens the browser, and its page arrives through onLogin. A new one cancels the last. */
  login(cwd: string | undefined, server: string): Promise<McpLoginResult>;
  onLogin(listener: (update: McpLoginUpdate) => void): () => void;
  cancelLogin(): void;
  logout(cwd: string | undefined, server: string): Promise<void>;
}

/** The laments live in main, which agents file them with; every change is pushed back. */
export interface LamentsApi {
  get(): Promise<Revved<Laments>>;
  /** Rejects with the reason for an invalid op (unknown lament). */
  apply(op: LamentOp, baseRev?: number): Promise<Revved<Laments>>;
  onChange(listener: (laments: Revved<Laments>) => void): () => void;
}

/** Custom themes live in main, which agents change too (set_theme); every change is pushed back. */
export interface ThemesApi {
  get(): Promise<Revved<Themes>>;
  /** Rejects with the reason for an invalid op (a bad color, an image outside the project). */
  apply(op: ThemeOp, baseRev?: number): Promise<Revved<Themes>>;
  onChange(listener: (themes: Revved<Themes>) => void): () => void;
  image(project: string, kind: "wallpaper" | "logo"): Promise<string | null>;
  /** The project on screen, whose theme's appearance mode the app takes. */
  active(project: string | null): void;
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

/** The first-run Setup flow (src/shared/setup.ts): what pi-gna found, and pi's install with npm's output line by line. */
export interface SetupApi {
  status(): Promise<SetupStatus>;
  installPi(): Promise<SetupInstallResult>;
  onLine(listener: (line: string) => void): () => void;
}

export interface UpdateApi {
  state(): Promise<UpdateState>;
  onState(listener: (state: UpdateState) => void): () => void;
  /** Download, verify and stage the available release. */
  download(): Promise<void>;
  /** pi-gna > Check for Updates… found one: show it. */
  onReveal(listener: () => void): () => void;
}

/** Remote access (docs/REMOTE.md): the Mac's own controls. Pairing codes go to this window only, never to a phone. */
export interface RemoteApi {
  /** Re-reads Tailscale and returns the status. */
  get(): Promise<RemoteStatus>;
  onChange(listener: (status: RemoteStatus) => void): () => void;
  enable(port?: number): Promise<RemoteStatus>;
  disable(): Promise<RemoteStatus>;
  /** `tailscale serve --bg --https=443`, only on a click; refused with Funnel on. */
  serve(): Promise<RemoteStatus>;
  unserve(): Promise<RemoteStatus>;
  devices(): Promise<DeviceInfo[]>;
  onDevices(listener: (devices: DeviceInfo[]) => void): () => void;
  revoke(id: string): Promise<DeviceInfo[]>;
  revokeAll(): Promise<DeviceInfo[]>;
  /** A fresh one-time code. */
  pairStart(): Promise<PairingStatus>;
  pairing(): Promise<PairingStatus>;
  pairDecide(request: string, allow: boolean): Promise<PairingStatus>;
  onPairing(listener: (status: PairingStatus) => void): () => void;
}

export interface BrowserApi {
  layout(layout: BrowserLayout): void;
  /** Tell main which chat is on screen: the pane shows that chat's tabs (undefined: none). */
  focus(chat?: string): void;
  newTab(url?: string): void;
  closeTab(id: string): void;
  activate(id: string): void;
  navigate(id: string, input: string): void;
  command(id: string, command: BrowserCommand): void;
  annotate(on: boolean): void;
  inspect(id: string): void;
  /** A still (JPEG data URL) of the page drawn in the pane, or null: shown in its place while a DOM overlay hides it. */
  still(): Promise<string | null>;
  /** Set a tab's emulated viewport (resolved through resolveViewport) or reset it with null. Rejects invalid input. */
  viewport(id: string, request: ViewportRequest | null): Promise<ViewportSpec | null>;
  /** Move a pane tab into its own window. Rejects at the window limit. */
  popOut(id: string): Promise<void>;
  /** Move a window tab back into the pane. */
  returnToPane(id: string): Promise<void>;
  /** For each chat link target: the absolute path of the existing file it names (resolved against `cwd`), or null. */
  resolvePreviewTargets(cwd: string, targets: string[]): Promise<(string | null)[]>;
  /** The bytes of an image a chat answer embeds (`![alt](target)`, resolved like a file link), or null. */
  readPreviewImage(cwd: string, target: string): Promise<{ mimeType: string; data: string } | null>;
  /** The favicon of the site a web link of a chat answer points to, or null. */
  siteIcon(url: string): Promise<{ mimeType: string; data: string } | null>;
  /** Open a local file in a preview tab (reusing one for the same file). Resolves with the tab id; rejects for missing paths and directories. */
  preview(path: string, options?: PreviewOpenOptions): Promise<string>;
  /** Show a Kanban card in a tab (reusing this chat's tab of the card). Resolves with the tab id. */
  card(card: string): Promise<string>;
  /** Switch a preview tab between its rendered and raw view. */
  previewMode(id: string, mode: PreviewMode): Promise<void>;
  /** Show a preview tab's file in Finder. */
  previewReveal(id: string): Promise<void>;
  /** Open a preview tab's file with its default app. */
  previewOpen(id: string): Promise<void>;
  history(): Promise<HistoryEntry[]>;
  state(): Promise<BrowserState>;
  onState(listener: (state: BrowserState) => void): () => void;
  /** The agent is about to use the browser of `chat`: show its pane. */
  onReveal(listener: (chat?: string) => void): () => void;
  /** `send`: the user chose Send in the picker rather than Add. */
  onAnnotation(listener: (annotation: Annotation, send: boolean) => void): () => void;
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
  /**
   * The desktop's view of the chat: its last page of turns and a line for each earlier one (the window pages those in
   * through `pageSession`). Events after its `seq` apply on top. A phone reads the chat through `chat.snapshot` instead.
   */
  snapshot?: ChatSnapshot & { seq: number };
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
  /** The page zoom factor (Cmd +/-, 1 at Actual Size). */
  zoomFactor: () => number;
  /** The running pi-gna's version (package.json, `app.getVersion()`), as in the About panel. */
  version: string;
  /** The Electron, Chromium and Node versions pi-gna runs on (Settings > About). */
  runtime: { electron: string; chrome: string; node: string };
  /** Quit and start pi-gna again from the build on disk, or as the staged update; running chats stop. */
  relaunch(): Promise<void>;
  listSessions(): Promise<ProjectGroup[]>;
  /** A settled run's session file was re-indexed: patch the list with it (patchProjects) rather than listing again. */
  onSessionIndexed(listener: (update: { path: string; summary: SessionSummary | null }) => void): () => void;
  openSession(request: OpenSessionRequest): Promise<OpenSessionResult>;
  /** Stop the chat's pi (explicit "Close chat"; also tells other clients). */
  closeSession(handle: string): Promise<void>;
  /** Leave a chat without stopping it: pi stops only if nobody else holds it and it is disposable. */
  detachSession(handle: string): Promise<void>;
  /** Join a live chat (one another client started, or one this window had before a reload); null when it ended. */
  attachSession(handle: string): Promise<(ChatSnapshot & { seq: number }) | null>;
  /**
   * The `turns` turns before turn `before` of a live chat (an earlier page, or one turn for the rail's preview); with
   * `offset`, before that many items into it (the rest of a turn whose last items came first).
   */
  pageSession(handle: string, before: number, turns: number, offset?: number): Promise<{ seq: number; value: ChatSnapshot }>;
  /** This window shows (or stops showing) the chat in the foreground. */
  viewing(handle: string, viewing: boolean): void;
  /** This window has the chat on screen, focused or not (the active chat, also behind a page): the host keeps its pi. */
  shown(handle: string, shown: boolean): void;
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
  /** View > Search… (⌘K): open or close the search over chats, cards, pages and commands. */
  onPaletteToggle(listener: () => void): () => void;
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
  themes: ThemesApi;
  computer: ComputerApi;
  settings: SettingsApi;
  ui: UiApi;
  auth: AuthApi;
  plugins: PluginsApi;
  github: GithubApi;
  atp: AtpApi;
  update: UpdateApi;
  setup: SetupApi;
  remote: RemoteApi;
}
