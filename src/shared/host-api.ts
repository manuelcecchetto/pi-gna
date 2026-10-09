// The remote contract of record, as types (docs/REMOTE.md): the HostCore method table, event and snapshot
// envelopes, errors and the allowlists that IPC and the remote server share. Types plus a few pure helpers; the
// behavior lives in main (EventHub, HostCore, RemoteServer) and the mobile HostClient.
import type { AtpPlan, AtpProjectPlans, AtpSession } from "./atp";
import type { Board, BoardOp, Column } from "./board";
import type { AuthMethod, AuthState, LoginResult, LoginUpdate } from "./auth";
import type { CatalogState, McpLoginResult, McpStatusState, PackageToggle, PluginsState, PluginToggle } from "./plugins";
import type { Annotation, BrowserCommand, BrowserState, HistoryEntry } from "./browser";
import type { CompactionSettings } from "./compaction";
import type { ComputerOp, ComputerSettings, Permissions } from "./computer";
import type { GithubFilter, GithubItem, GithubKind, GithubList, GithubLookup, GithubProject, GithubRepo } from "./github";
import type { LamentOp, Laments } from "./laments";
import type { ThemeOp, Themes } from "./themes";
import type { PreviewMode, PreviewOpenOptions, PreviewText } from "./preview";
import type { PiPatch, PiSettingsState } from "./pi-settings";
import type { SetupInstallResult, SetupStatus } from "./setup";
import type { ExtensionUiRequest, ExtensionUiResponse, RpcCommand, RpcCommandType, RpcResponse, RpcSessionState, SessionEvent } from "./protocol";
import type { KeepAwake, Settings, SettingsOp } from "./settings";
import type { TailscaleStatus } from "./tailscale";
import type { TurnOutline } from "./turn-outline";
import type { UiOp } from "./ui-state";
import type { ViewportRequest, ViewportSpec } from "./viewport";
import type { DialogAnswer, OpenSessionRequest, OpenSessionResult, PickedPath, ProjectGroup, SessionSummary, UpdateState } from "./ipc";

// ── Envelopes ────────────────────────────────────────────────────────────────

/** `global`, or `chat:<handle>`. */
export type Topic = "global" | `chat:${string}`;

/** Every push: `seq` is host-global and monotonic, `bootId` changes on each launch of pi-gna. */
export interface EventEnvelope<E = HostEvent | GlobalEvent> {
  bootId: string;
  seq: number;
  topic: Topic;
  event: E;
}

/** A value and the `seq` of the last event it reflects; clients apply only events with a greater `seq`. */
export interface Snapshot<T> {
  seq: number;
  value: T;
}

/** The ring buffer behind replay: the oldest events fall out past either bound (then a client resyncs). */
export const RING_MAX_EVENTS = 2000;
export const RING_MAX_BYTES = 8 * 1024 * 1024;
/** SSE: a heartbeat comment every 15 s; clients reconnect after 35 s of silence. */
export const HEARTBEAT_MS = 15_000;
export const WATCHDOG_MS = 35_000;
/** A lease whose stream closed survives this long (a suspended page reconnecting). */
export const LEASE_GRACE_MS = 60_000;
/** Idempotent results are kept this long, at most this many per device. */
export const IDEMPOTENCY_TTL_MS = 10 * 60_000;
export const IDEMPOTENCY_MAX_ENTRIES = 1000;

/** SSE `id:` value, `<bootId>:<seq>`. */
export function formatEventId(bootId: string, seq: number): string {
  return `${bootId}:${seq}`;
}

/** The inverse, for `Last-Event-ID`; null when malformed (the client then resyncs). */
export function parseEventId(value: string | null | undefined): { bootId: string; seq: number } | null {
  if (!value) return null;
  const at = value.lastIndexOf(":");
  if (at < 1) return null;
  const bootId = value.slice(0, at);
  const raw = value.slice(at + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(bootId) || !/^\d{1,15}$/.test(raw)) return null;
  return { bootId, seq: Number(raw) };
}

/** What a stream should do with a `Last-Event-ID`: replay the gap, or resync from snapshots. */
export type Replay = { kind: "replay"; from: number } | { kind: "resync"; reason: "no_id" | "new_boot" | "gap" };

/** `oldest` is the `seq` of the oldest event still in the ring (null when empty), `latest` the newest `seq` issued. */
export function planReplay(lastId: string | null | undefined, bootId: string, oldest: number | null, latest: number): Replay {
  const id = parseEventId(lastId);
  if (!id) return { kind: "resync", reason: "no_id" };
  if (id.bootId !== bootId) return { kind: "resync", reason: "new_boot" };
  if (id.seq > latest) return { kind: "resync", reason: "gap" };
  if (id.seq === latest) return { kind: "replay", from: latest + 1 };
  if (oldest === null || id.seq + 1 < oldest) return { kind: "resync", reason: "gap" };
  return { kind: "replay", from: id.seq + 1 };
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Who answered a dialog, closed a chat, and so on: the desktop window or a paired device. */
export type Actor = "desktop" | { device: string };

export type DialogOutcome = "answered" | "cancelled" | "timeout" | "exit";

/** Who is looking at a chat right now (leases). */
export interface ClientPresence {
  clientId: string;
  /** `desktop`, or the paired device's id. */
  actor: "desktop" | string;
  /** The chat is that client's foreground chat. */
  viewing?: boolean;
}

/** The attention marks of a chat, kept live for chats a client does not subscribe to. */
export interface AttentionSummary {
  handle: string;
  cwd: string;
  /** The session file, once it has one: matches the chat to its row in `chat.list`. */
  sessionPath?: string;
  title: string;
  /** Shown in the chat lists before its file is indexed, like the desktop sidebar's open chats (`isListed`). */
  listed: boolean;
  attention: "waiting" | "running" | "failed" | "unread" | "idle";
  running: boolean;
  dialogs: number;
  /** How the last run ended and when (host clock), absent before the first one. */
  settled?: { outcome: "done" | "error"; at: number };
}

/** What the host pushes on `chat:<handle>`. The first three are today's `HostEvent` (src/shared/ipc.ts). */
export type HostEvent =
  | { kind: "rpc"; record: SessionEvent | ExtensionUiRequest }
  | { kind: "ready"; state: RpcSessionState }
  | { kind: "exit"; code: number | null; signal: string | null; error?: string; stderrTail: string }
  /** A dialog (extension UI or a main-owned approval) was settled; every client drops its card. */
  | { kind: "dialog_resolved"; id: string; by: Actor; outcome: DialogOutcome }
  /** Clients holding a lease on the chat changed. */
  | { kind: "lease"; clients: ClientPresence[] }
  /** The chat was closed explicitly (`chat.close`) or pi stopped it; clients leave it. */
  | { kind: "closed"; by: Actor | "host" };

/** What the host pushes on `global`. Store values carry `rev`. */
export type GlobalEvent =
  | { kind: "projects"; projects: ProjectGroup[] }
  /** A run settled and its session file was re-indexed: clients patch their `chat.list` with it (patchProjects); null drops the row. */
  | { kind: "session.indexed"; path: string; summary: SessionSummary | null }
  | { kind: "attention"; chats: AttentionSummary[]; removed: string[] }
  | { kind: "chat.opened"; handle: string; cwd: string; sessionPath?: string }
  | { kind: "chat.closed"; handle: string }
  | { kind: "board"; board: Revved<Board> }
  | { kind: "laments"; laments: Revved<Laments> }
  | { kind: "themes"; themes: Revved<Themes> }
  | { kind: "settings"; settings: Revved<Settings> }
  | { kind: "computer"; settings: Revved<ComputerSettings> }
  | { kind: "ui"; ui: Revved<UiState> }
  | { kind: "atp.plans"; plans: AtpProjectPlans }
  | ({ kind: "atp.runners" } & AtpRunnerState)
  | { kind: "atp.threads"; plan: string; threads: AtpPlanThreads }
  | { kind: "atp.held"; plans: string[] }
  | { kind: "browser"; state: BrowserState }
  /** The agent opened a browser tab: clients show the browser. */
  | { kind: "browser.reveal"; chat?: string }
  /** `send`: sent from the picker's Send, so the desktop sends the chat's comments at once. */
  | { kind: "browser.annotation"; annotation: Annotation; send?: boolean }
  | { kind: "update"; state: UpdateState }
  | { kind: "providers.login"; update: LoginUpdate }
  | { kind: "devices"; devices: DeviceInfo[] }
  | { kind: "remote"; status: RemoteStatus };

/** A store value with its revision (incremented on every applied change; files without one load as 0). */
export type Revved<T> = T & { rev: number };

/** One plan's run, while the host runs it (src/main/atp-runner.ts). */
export interface AtpRunner {
  plan: string;
  /** The project the workers work in. */
  cwd: string;
  phase: "starting" | "claiming" | "working" | "nudging" | "committing" | "held" | "stopping";
  /** The node being worked, when a worker is running. */
  node?: string;
  title?: string;
  /** The worker chat's handle. */
  handle?: string;
  since: number;
}

/** Why a plan's run stopped by itself, or what it did last; until the plan starts again. */
export interface AtpRunNote {
  level: "info" | "error";
  text: string;
  at: number;
}

/** What the host knows of ATP runs: published whole on every change (a few plans at most). */
export type AtpRunnerState = {
  runners: Record<string, AtpRunner>;
  notes: Record<string, AtpRunNote>;
  /** Live orchestrator chats: by plan, or `new:<project>` for a plan the architect is still writing. */
  orchestrators: Record<string, string>;
};

/** Which chats worked on a plan: its orchestrator's session file and, per node, its workers' (oldest first; a node runs again after a stop). */
export interface AtpPlanThreads {
  orchestrator?: string;
  workers: Record<string, string[]>;
}

/** Pins, hidden projects and bookmarks, host-side (they were renderer localStorage); ops in src/shared/ui-state.ts. */
export interface UiState {
  /** Pinned project folders, in order. */
  pins: string[];
  /** Project folders left out of the project lists; their chats stay on disk and in the index. */
  hidden: string[];
  /** Per session file: the timestamps of the bookmarked messages. */
  bookmarks: Record<string, number[]>;
}

/** Who is calling a host method: the desktop window (trusted) or a paired device. */
export interface HostCtx {
  caller: "desktop" | { device: string };
  clientId: string;
  bootId: string;
}

/** The `Actor` for events and logs. */
export const actorOf = (ctx: HostCtx): Actor => (ctx.caller === "desktop" ? "desktop" : ctx.caller);

// ── Errors ───────────────────────────────────────────────────────────────────

export const HOST_ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  scope_denied: 403,
  not_found: 404,
  conflict: 409,
  already_answered: 409,
  host_restarted: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type HostErrorCode = keyof typeof HOST_ERROR_STATUS;

/** The error body of every failed call: `{ error: HostErrorBody }`. */
export interface HostErrorBody {
  code: HostErrorCode;
  message: string;
  /** Machine-readable extras: `{ rev }` on conflict, `{ reason: "idempotency_mismatch" }` on bad_request, `{ retryAfter }`. */
  detail?: Record<string, unknown>;
}

export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HostError";
  }

  get status(): number {
    return HOST_ERROR_STATUS[this.code];
  }

  toBody(): HostErrorBody {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

// ── RPC allowlist ────────────────────────────────────────────────────────────

/** The only RPC commands `chat.command` forwards to pi for a remote caller; `bash`, `new_session` and the rest are refused. */
export const RPC_ALLOWLIST: ReadonlySet<RpcCommandType> = new Set<RpcCommandType>([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "set_model",
  "set_thinking_level",
  "compact",
  "abort_retry",
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
  "get_commands",
  "set_session_name",
]);

export function isAllowedRpc(command: { type?: unknown }): boolean {
  return typeof command.type === "string" && RPC_ALLOWLIST.has(command.type as RpcCommandType);
}

// ── Headers, cookie, CSP ─────────────────────────────────────────────────────

export const HEADER_IDEMPOTENCY = "idempotency-key";
export const HEADER_BOOT = "x-pigna-boot";
export const HEADER_CLIENT = "x-pigna-client";
export const DEVICE_COOKIE = "pigna_device";
/** 400 days: persistent, because iOS dropped session cookies in Home Screen apps. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export const REMOTE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

export const DEFAULT_REMOTE_PORT = 4517;
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOADS_PER_MESSAGE = 10;

// ── Pairing and devices ──────────────────────────────────────────────────────

export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_APPROVAL_TIMEOUT_MS = 2 * 60_000;

export type PairingState = "idle" | "code_issued" | "pending_approval" | "approved" | "denied" | "expired" | "locked";

/** A paired device as clients see it; the token hash never leaves the host. */
export interface DeviceInfo {
  id: string;
  name: string;
  userAgent: string;
  tailnetLogin: string;
  createdAt: number;
  lastSeenAt: number;
  /** Reserved for read-only devices (not in v1: every device is "full"). */
  scope: "full";
  /** The caller's own device. */
  current?: boolean;
}

export interface PairingStatus {
  state: PairingState;
  /** The code and its expiry, only while `code_issued` and only for the Mac. */
  code?: string;
  expiresAt?: number;
  /** The device asking, while `pending_approval`. */
  request?: { id: string; deviceName: string; userAgent: string; tailnetLogin: string };
}

export type { KeepAwake };

export interface RemoteStatus {
  enabled: boolean;
  port: number;
  /** `https://<mac>.<tailnet>.ts.net` once `tailscale serve` is on. */
  url?: string;
  serve: "off" | "on" | "funnel_refused" | "unavailable";
  keepAwake: KeepAwake;
  /** The sleep blocker is held now. */
  awake: boolean;
  devices: number;
  /** The local server is listening (127.0.0.1:port). */
  listening: boolean;
  /** Event streams open now: the phones connected. */
  connected: number;
  /** Why the server could not start (port in use). */
  error?: string;
  /** What `tailscale` reports; the Mac's Settings shows the fixes. */
  tailscale: TailscaleStatus;
}

// ── Chat contract ────────────────────────────────────────────────────────────

/**
 * The session reducer's state (`SessionState`, src/shared/session-state.ts). Kept opaque here because
 * session-state.ts imports this file's `HostEvent`; main and clients cast to `SessionState` at the edge.
 */
export type SessionStateJson = Record<string, unknown>;

export interface ChatSnapshot {
  state: SessionStateJson;
  /**
   * Turns in the session and the first one `state` holds (earlier ones come from `chat.snapshot({ before })`). A turn
   * too big for one page comes in parts, its last items first: `offset` items of turn `from` are before `state`, and
   * come from `chat.snapshot({ before: from, offset })`.
   */
  turns: { total: number; from: number; offset?: number };
  /** The turns whose prompt is before `state`, one line each, when asked for: the desktop's turn rail shows them before they load. */
  outline?: TurnOutline[];
}

/** An attachment a send names: an upload, or a path on the host. */
export type AttachmentRef = { upload: string } | { path: string };

export type TaskKind = "triage" | "investigate" | "resolve" | "qa" | "discuss" | "fix" | "review";

export type TaskTarget =
  | { kind: "triage" | "investigate" | "resolve" | "qa" | "discuss"; card: string }
  | { kind: "fix"; lament: string }
  /** `repo` and `item` as the GitHub page lists them (github.project, github.list); `login`: the gh account pi-gna reads the repository as. */
  | { kind: "review"; cwd: string; repo: GithubRepo; item: GithubItem; login?: string };

/** What the client tells its user (the desktop toasts it): a warning about a task's setup, or what the chat is doing. */
export interface TaskNotice {
  level: "info" | "warning";
  text: string;
}

/** The chat a task started, once its prompt is sent: the caller attaches to it (the snapshot's seq says which events it still has to apply). */
export interface TaskStarted {
  handle: string;
  snapshot: (ChatSnapshot & { seq: number }) | null;
  notices: TaskNotice[];
}

/** A new card's attachment as a client sends it: a pasted image's bytes, or a file already on the host. */
export type NewCardAttachment = { kind: "image"; mimeType: string; data: string } | { kind: "file"; path: string };

export type QueueKind = "steering" | "followUp";
export type QueueEdit = { type: "remove" | "move"; kind: QueueKind; text: string };

export interface PrettyFolder {
  name: string;
  path: string;
}

export interface FolderListing {
  path: string;
  /** null at the root of what may be browsed. */
  parent: string | null;
  folders: PrettyFolder[];
  /** File names (no contents), only when the listing asked for them (the attachment picker). */
  files?: PrettyFolder[];
}

export interface UploadResult {
  id: string;
  path: string;
  name: string;
  image?: { mimeType: string };
}

export interface AppInfo {
  homeDir: string;
  launchCwd: string;
  version: string;
  buildId: string;
}

export interface HelloResult {
  buildId: string;
  bootId: string;
  authenticated: boolean;
}

// ── The method table ─────────────────────────────────────────────────────────

/** `remote`: IPC and the remote server; `desktop`: IPC only (the remote server answers `scope_denied`). */
export type MethodScope = "remote" | "desktop";

/** One entry per method: its argument object and result. */
export interface HostMethods {
  // chat
  "chat.list": { args: Record<string, never>; result: ProjectGroup[] };
  /** A remote caller gets `entries: []`: its snapshot comes from `chat.snapshot`, not from the session file. */
  "chat.open": { args: { request: OpenSessionRequest }; result: OpenSessionResult };
  /** Null when the chat ended meanwhile. */
  /** A remote caller gets only `{ seq }`: it reads the transcript through `chat.snapshot`. */
  "chat.attach": { args: { handle: string }; result: (ChatSnapshot & { seq: number }) | { seq: number } | null };
  /** This client shows (or stops showing) the chat in the foreground; that marks a finished run as seen. */
  "chat.viewing": { args: { handle: string; viewing: boolean }; result: null };
  /** The window has the chat on screen, focused or not (its active chat, also behind a page): its pi is not stopped for being idle. */
  "chat.shown": { args: { handle: string; shown: boolean }; result: null };
  /** Attention summaries of every live chat. */
  "chat.live": { args: Record<string, never>; result: AttentionSummary[] };
  "chat.detach": { args: { handle: string }; result: null };
  "chat.close": { args: { handle: string }; result: null };
  /** `turns`: page size, 1 to 40 (default 40). */
  "chat.snapshot": { args: { handle: string; before?: number; offset?: number; turns?: number; bytes?: number }; result: Snapshot<ChatSnapshot> };
  "chat.send": {
    args: { handle: string; text: string; mode: "send" | "followUp"; attachments?: AttachmentRef[]; annotations?: Annotation[]; cardId?: string };
    result: { accepted: boolean; error?: string };
  };
  "chat.command": { args: { handle: string; command: RpcCommand }; result: RpcResponse };
  "chat.interrupt": { args: { handle: string }; result: string[] };
  "chat.editQueue": { args: { handle: string; op: QueueEdit }; result: boolean };
  "chat.respondDialog": { args: { handle: string; response: ExtensionUiResponse }; result: DialogAnswer };
  "chat.startTask": { args: { target: TaskTarget }; result: TaskStarted };
  "chat.files": { args: { cwd: string }; result: string[] };
  "chat.compactionSettings": { args: Record<string, never>; result: CompactionSettings };
  "chat.rawCommand": { args: { handle: string; command: RpcCommand }; result: RpcResponse };

  // stores
  "board.get": { args: Record<string, never>; result: Snapshot<Revved<Board>> };
  "board.apply": { args: { op: BoardOp; baseRev?: number }; result: Revved<Board> };
  "board.addCard": {
    args: { cwd: string; column: Column; description: string; attachments?: NewCardAttachment[] };
    result: { id: string };
  };
  "board.saveImage": { args: { card: string; image: { mimeType: string; data: string } }; result: string };
  "laments.get": { args: Record<string, never>; result: Snapshot<Revved<Laments>> };
  "laments.apply": { args: { op: LamentOp; baseRev?: number }; result: Revved<Laments> };
  "themes.get": { args: Record<string, never>; result: Snapshot<Revved<Themes>> };
  "themes.apply": { args: { op: ThemeOp; baseRev?: number }; result: Revved<Themes> };
  /** A project theme's wallpaper or logo as a data: URL; null when it has none or the file is gone. */
  "themes.image": { args: { project: string; kind: "wallpaper" | "logo" }; result: string | null };
  /** The project on the window's screen: its theme's appearance mode becomes the app's. */
  "themes.active": { args: { project: string | null }; result: null };
  "settings.get": { args: Record<string, never>; result: Snapshot<Revved<Settings>> };
  "settings.apply": { args: { op: SettingsOp; baseRev?: number }; result: Revved<Settings> };
  "settings.pi": { args: Record<string, never>; result: PiSettingsState };
  "settings.setPi": { args: { patch: PiPatch }; result: PiSettingsState };
  "settings.revealPi": { args: Record<string, never>; result: null };
  "computer.get": { args: Record<string, never>; result: Snapshot<Revved<ComputerSettings>> };
  "computer.apply": { args: { op: ComputerOp; baseRev?: number }; result: Revved<ComputerSettings> };
  "computer.permissions": { args: Record<string, never>; result: Permissions };
  "computer.requestPermissions": { args: { pane?: "accessibility" | "screen_recording" }; result: Permissions };
  "computer.openSettings": { args: { pane: "accessibility" | "screen_recording" }; result: null };
  "computer.preview": { args: { handle: string }; result: { mimeType: string; data: string; app: string } | null };
  "ui.get": { args: Record<string, never>; result: Snapshot<Revved<UiState>> };
  "ui.apply": { args: { op: UiOp; baseRev?: number }; result: Revved<UiState> };
  "ui.importLegacy": { args: { ui: unknown }; result: null };

  // atp
  /** One scan of the project, no watching: the phone asks again while its ATP page is open. */
  "atp.plans": { args: { cwd: string }; result: AtpProjectPlans };
  "atp.read": { args: { plan: string }; result: AtpPlan };
  "atp.start": { args: { plan: string; cwd: string }; result: null };
  "atp.stop": { args: { plan: string }; result: null };
  "atp.releaseInterrupted": { args: { plan: string; node: string }; result: null };
  "atp.liftHold": { args: { plan: string }; result: null };
  "atp.threads": { args: { plan: string }; result: AtpPlanThreads };
  /** Opens (or joins) the plan's orchestrator chat for this client; without `plan`, the chat for a plan the architect is about to write. */
  "atp.orchestrator": { args: { cwd: string; plan?: string }; result: { handle: string } };
  /** The client no longer shows the plans: idle orchestrators stop, busy ones when they finish. */
  "atp.releaseOrchestrators": { args: Record<string, never>; result: null };
  /** Drop the project's new-plan chat, so the next one starts fresh. */
  "atp.discardNewPlan": { args: { cwd: string }; result: null };
  /** The desktop's threads from before they lived in the host (localStorage), merged once. */
  "atp.importThreads": { args: { threads: unknown }; result: null };
  "atp.state": { args: Record<string, never>; result: Snapshot<AtpRunnerState & { held: string[] }> };

  // browser
  "browser.state": { args: Record<string, never>; result: Snapshot<BrowserState> };
  "browser.history": { args: Record<string, never>; result: HistoryEntry[] };
  /** The data URL of a tab's icon by its `faviconKey`, or null once no tab shows it. */
  "browser.favicon": { args: { key: string }; result: string | null };
  "browser.newTab": { args: { url?: string; agent?: string }; result: { id: string } | null };
  "browser.closeTab": { args: { id: string }; result: null };
  "browser.activate": { args: { id: string }; result: null };
  "browser.navigate": { args: { id: string; input: string }; result: null };
  "browser.command": { args: { id: string; command: BrowserCommand }; result: null };
  "browser.annotate": { args: { on: boolean }; result: null };
  "browser.inspect": { args: { id: string }; result: null };
  "browser.viewport": { args: { id: string; request: ViewportRequest | null }; result: ViewportSpec | null };
  "browser.view": { args: { id: string; on: boolean; maxWidth?: number }; result: { stream: string } | null };
  "browser.input": { args: { id: string; input: BrowserInput }; result: { annotation?: Annotation } | null };
  "browser.layout": { args: { layout: unknown }; result: null };
  "browser.still": { args: Record<string, never>; result: string | null };
  "browser.focus": { args: { chat?: string }; result: null };
  "browser.popOut": { args: { id: string }; result: null };
  "browser.returnToPane": { args: { id: string }; result: null };
  "browser.preview": { args: { path: string; options?: PreviewOpenOptions }; result: string };
  "browser.card": { args: { card: string }; result: string };
  "browser.previewMode": { args: { id: string; mode: PreviewMode }; result: null };
  "browser.previewReveal": { args: { id: string }; result: null };
  "browser.previewOpen": { args: { id: string }; result: null };
  "browser.resolveTargets": { args: { cwd: string; targets: string[] }; result: (string | null)[] };
  "browser.readImage": { args: { cwd: string; target: string }; result: { mimeType: string; data: string } | null };
  "browser.siteIcon": { args: { url: string }; result: { mimeType: string; data: string } | null };
  "browser.reveal": { args: Record<string, never>; result: null };
  /** A chat's links on a phone, confined to the chat's directory and project (the desktop uses browser.resolveTargets and friends). */
  /** `from`: resolve against this folder (of a file the phone shows) instead of the chat's directory. */
  "chat.resolveLinks": { args: { handle: string; targets: string[]; from?: string }; result: (string | null)[] };
  "chat.linkImage": { args: { handle: string; target: string; from?: string }; result: { mimeType: string; data: string } | null };
  /** A file of the chat's folders as text, for the phone to draw itself (Markdown, code, JSON, tables). */
  "chat.readFile": { args: { handle: string; path: string }; result: PreviewText };
  /** Preview a file of the chat's folders in a tab the chat owns; the tab's id. */
  "chat.openFile": { args: { handle: string; path: string; line?: number }; result: { id: string } };

  // fs, uploads
  "fs.browseFolders": { args: { path?: string; files?: boolean; hidden?: boolean }; result: FolderListing };
  "fs.pickFolder": { args: Record<string, never>; result: string | null };
  "fs.pickAttachments": { args: { kind: "photos" | "files" }; result: PickedPath[] };
  "fs.describePaths": { args: { paths: string[] }; result: PickedPath[] };
  "uploads.discard": { args: { id: string }; result: null };

  // devices, remote, app
  "devices.list": { args: Record<string, never>; result: DeviceInfo[] };
  "devices.rename": { args: { id: string; name: string }; result: DeviceInfo[] };
  "devices.revoke": { args: { id: string }; result: DeviceInfo[] };
  "devices.revokeAll": { args: Record<string, never>; result: DeviceInfo[] };
  // Web Push (docs/REMOTE.md section 13a); the device is the caller.
  "push.vapidKey": { args: Record<string, never>; result: string };
  "push.state": { args: Record<string, never>; result: { subscribed: boolean; prefs: Record<"approval" | "done" | "failed" | "plan" | "host_quit", boolean> } };
  "push.subscribe": { args: { endpoint: string; p256dh: string; auth: string }; result: null };
  "push.unsubscribe": { args: Record<string, never>; result: null };
  "push.setPrefs": { args: { prefs: Partial<Record<"approval" | "done" | "failed" | "plan" | "host_quit", boolean>> }; result: Record<"approval" | "done" | "failed" | "plan" | "host_quit", boolean> };
  "devices.pairStart": { args: Record<string, never>; result: PairingStatus };
  "devices.pairing": { args: Record<string, never>; result: PairingStatus };
  "devices.pairDecide": { args: { request: string; allow: boolean }; result: PairingStatus };
  "remote.get": { args: Record<string, never>; result: RemoteStatus };
  "remote.enable": { args: { port?: number }; result: RemoteStatus };
  "remote.disable": { args: Record<string, never>; result: RemoteStatus };
  "remote.serve": { args: Record<string, never>; result: RemoteStatus };
  "remote.unserve": { args: Record<string, never>; result: RemoteStatus };
  "remote.setKeepAwake": { args: { keepAwake: KeepAwake }; result: RemoteStatus };
  "app.hello": { args: Record<string, never>; result: HelloResult };
  "app.info": { args: Record<string, never>; result: AppInfo };

  // providers
  "providers.list": { args: Record<string, never>; result: AuthState };
  "providers.login": { args: { provider: string; method: AuthMethod }; result: LoginResult };
  "providers.answer": { args: { n: number; value: string }; result: null };
  "providers.cancel": { args: Record<string, never>; result: null };
  "providers.logout": { args: { provider: string }; result: null };

  // plugins (desktop only: installs run code, sign-ins open the Mac's browser)
  "plugins.catalog": { args: Record<string, never>; result: CatalogState };
  "plugins.state": { args: { cwd?: string }; result: PluginsState };
  "plugins.status": { args: { cwd?: string }; result: McpStatusState };
  "plugins.toggle": { args: { cwd?: string; toggle: PluginToggle }; result: null };
  "plugins.togglePackage": { args: { cwd?: string; toggle: PackageToggle }; result: null };
  "plugins.install": { args: { id: string }; result: null };
  "plugins.remove": { args: { cwd?: string; source: string; scope: "user" | "project" }; result: null };
  "plugins.connect": { args: { id: string; endpoint: string; token?: string }; result: null };
  "plugins.disconnect": { args: { cwd?: string; server: string; scope: "global" | "project" }; result: null };
  "plugins.enableServer": { args: { cwd?: string; server: string; scope: "global" | "project"; enabled: boolean }; result: null };
  "plugins.login": { args: { cwd?: string; server: string }; result: McpLoginResult };
  "plugins.cancelLogin": { args: Record<string, never>; result: null };
  "plugins.logout": { args: { cwd?: string; server: string }; result: null };

  // setup (desktop only: installs run code on the Mac)
  "setup.status": { args: Record<string, never>; result: SetupStatus };
  "setup.installPi": { args: Record<string, never>; result: SetupInstallResult };

  // github
  "github.project": { args: { cwd: string; refresh?: boolean }; result: GithubProject };
  "github.choose": { args: { cwd: string; login: string | null }; result: GithubProject };
  "github.list": { args: { cwd: string; kind: GithubKind; filter: GithubFilter }; result: GithubList };
  "github.lookup": { args: { cwd: string; input: string }; result: GithubLookup };

  // update, host
  "update.get": { args: Record<string, never>; result: UpdateState };
  "update.download": { args: Record<string, never>; result: null };
  "update.restart": { args: Record<string, never>; result: null };
  "host.relaunch": { args: Record<string, never>; result: null };
  "host.openExternal": { args: { url: string }; result: null };
  "host.windowFocused": { args: Record<string, never>; result: boolean };
  "host.focusWindow": { args: Record<string, never>; result: null };
  "host.killVisual": { args: { frameId: string }; result: null };
}

export type HostMethod = keyof HostMethods;
export type HostArgs<M extends HostMethod> = HostMethods[M]["args"];
export type HostResult<M extends HostMethod> = HostMethods[M]["result"];

/** Input sent to a host browser tab from the phone. Coordinates are CSS px of the page viewport (the frame's `X-Css-Width` x `X-Css-Height`). */
export type BrowserInput =
  | { type: "tap"; x: number; y: number }
  | { type: "longPress"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  /** Comment mode: the element at the tapped point becomes an annotation with this comment (returned to the caller only). */
  | { type: "pick"; x: number; y: number; comment: string };

/** Methods that only the desktop window may call. Everything else in `HostMethods` is scope "remote". */
export const DESKTOP_ONLY_METHODS = [
  "chat.rawCommand",
  "chat.shown",
  "settings.revealPi",
  "themes.apply",
  "themes.active",
  "computer.openSettings",
  "atp.importThreads",
  "ui.importLegacy",
  "browser.layout",
  "browser.still",
  "browser.focus",
  "browser.popOut",
  "browser.returnToPane",
  "browser.preview",
  "browser.card",
  "browser.previewReveal",
  "browser.previewOpen",
  "browser.resolveTargets",
  "browser.readImage",
  "browser.siteIcon",
  "browser.reveal",
  "fs.pickFolder",
  "fs.pickAttachments",
  "fs.describePaths",
  "devices.revokeAll",
  "devices.pairStart",
  "devices.pairing",
  "devices.pairDecide",
  "remote.enable",
  "remote.disable",
  "remote.serve",
  "remote.unserve",
  "remote.setKeepAwake",
  "update.restart",
  "host.relaunch",
  "host.openExternal",
  "host.windowFocused",
  "host.focusWindow",
  "host.killVisual",
  "plugins.catalog",
  "plugins.state",
  "plugins.status",
  "plugins.toggle",
  "plugins.togglePackage",
  "plugins.install",
  "plugins.remove",
  "plugins.connect",
  "plugins.disconnect",
  "plugins.enableServer",
  "plugins.login",
  "plugins.cancelLogin",
  "plugins.logout",
  "setup.status",
  "setup.installPi",
] as const satisfies readonly HostMethod[];

const DESKTOP_ONLY: ReadonlySet<string> = new Set(DESKTOP_ONLY_METHODS);

export function methodScope(method: HostMethod): MethodScope {
  return DESKTOP_ONLY.has(method) ? "desktop" : "remote";
}

/** Methods that change nothing; every other method mutates, so remote calls to it need an `Idempotency-Key`. */
export const READ_ONLY_METHODS = [
  "chat.list",
  "chat.live",
  "chat.attach",
  "chat.snapshot",
  "chat.files",
  "chat.resolveLinks",
  "chat.linkImage",
  "chat.readFile",
  "chat.compactionSettings",
  "setup.status",
  "board.get",
  "laments.get",
  "themes.get",
  "themes.image",
  "settings.get",
  "settings.pi",
  "computer.get",
  "computer.permissions",
  "computer.preview",
  "ui.get",
  "atp.plans",
  "atp.read",
  "atp.threads",
  "atp.state",
  "browser.state",
  "browser.history",
  "browser.favicon",
  "fs.browseFolders",
  "fs.describePaths",
  "devices.list",
  "devices.pairing",
  "push.vapidKey",
  "push.state",
  "remote.get",
  "app.hello",
  "app.info",
  "providers.list",
  "plugins.catalog",
  "plugins.state",
  "plugins.status",
  "github.project",
  "github.list",
  "github.lookup",
  "update.get",
] as const satisfies readonly HostMethod[];

const READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_METHODS);

export function methodMutates(method: HostMethod): boolean {
  return !READ_ONLY.has(method);
}
