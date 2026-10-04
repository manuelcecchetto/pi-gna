// Wire protocol between Electron main and the native "pi-gna Computer Use" helper (docs/DESIGN.md, "Computer Use").
// Newline-delimited JSON-RPC 2.0 over a Unix socket; main is the only client.

export const COMPUTER_PROTOCOL = 1;

/** Helper error codes (helper range -32000...-32099); `message` is always safe to show the model. */
export const ComputerErrorCode = {
  permissionDenied: -32001,
  appNotFound: -32002,
  windowNotFound: -32003,
  staleElement: -32004,
  actionFailed: -32005,
  cancelled: -32006,
  deniedApp: -32007,
  invalidParams: -32008,
  helperCrashed: -32009,
  timeout: -32010,
  /** Cannot be done without taking the foreground (window not on screen, no menu item for a shortcut, ...); never silently activates. */
  backgroundUnsupported: -32011,
  /** Standard-ish codes the helper uses before authentication and for unknown methods. */
  unauthorized: -32600,
  methodNotFound: -32601,
} as const;

export interface Permissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface HelloResult {
  helperVersion: number;
  protocol: number;
  os: string;
  arch: string;
  pid?: number;
  permissions: Permissions;
}

export interface AppTarget {
  bundleId: string;
  pid?: number;
}

export interface AppInfo {
  id: string;
  bundleId?: string;
  displayName: string;
  isRunning: boolean;
  pid?: number;
  windows?: { id: number; title: string }[];
}

export interface AppStateResult {
  text: string;
  mode: "full" | "diff";
  bundleId: string;
  pid: number;
  windowId: number;
  focusedWindowTitle: string;
  revision: number;
  elementCount: number;
  note?: string;
}

export type AppRef = string | AppTarget;
export interface ActionParams {
  app: AppRef;
  window_id?: number;
}
export interface ActionResult {
  method?: string;
  settled?: boolean;
  [key: string]: unknown;
}

/** Method name -> [params, result]. Methods the helper has not implemented yet answer -32601. */
export interface ComputerMethods {
  hello: [{ token: string; protocol: number }, HelloResult];
  ping: [Record<string, never>, Record<string, unknown>];
  permissions: [{ prompt?: boolean }, Permissions];
  request_permissions: [Record<string, never>, Permissions];
  open_settings: [{ pane: "accessibility" | "screen_recording" }, Record<string, never>];
  list_apps: [Record<string, never>, { apps: AppInfo[] }];
  resolve_app: [{ app: string; launch?: boolean }, { bundleId: string; displayName: string; pid: number }];
  get_app_state: [{ app: string | AppTarget; window_id?: number; disable_diff?: boolean }, AppStateResult];
  screenshot: [{ app: AppRef; window_id?: number }, { jpeg: string; width: number; height: number; scale: number }];
  overlay_show: [{ app: AppRef; session_label: string; session: string; window_id?: number }, Record<string, unknown>];
  overlay_hide: [{ app?: AppRef }, Record<string, never>];
  click: [ActionParams & { element_index?: number; x?: number; y?: number; mouse_button?: "left" | "right" | "middle"; click_count?: number }, ActionResult];
  drag: [ActionParams & { from_x: number; from_y: number; to_x: number; to_y: number }, ActionResult];
  scroll: [ActionParams & { element_index?: number; x?: number; y?: number; direction: "up" | "down" | "left" | "right"; pages?: number }, ActionResult];
  type_text: [ActionParams & { text: string }, ActionResult];
  press_key: [ActionParams & { key: string }, ActionResult];
  set_value: [ActionParams & { element_index: number; value: string }, ActionResult];
  select_text: [ActionParams & { element_index: number; text: string; prefix?: string; suffix?: string; selection_type?: "text" | "cursor_before" | "cursor_after" }, ActionResult];
  perform_secondary_action: [ActionParams & { element_index: number; action: string }, ActionResult];
  paste: [ActionParams & { text: string; format?: "text" | "md" | "html" }, ActionResult];
  shutdown: [Record<string, never>, Record<string, never>];
}

export type ComputerMethod = keyof ComputerMethods;

export interface ComputerNotifications {
  cancelled: { app?: string; name?: string; session?: string; reason: "esc" };
  permissions_changed: Permissions;
  app_gone: { app?: string; session?: string };
}

export type ComputerNotification = { [K in keyof ComputerNotifications]: { method: K; params: ComputerNotifications[K] } }[keyof ComputerNotifications];

/** Error from the helper or raised by main (`helper_crashed`, `timeout`). */
export class ComputerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

// ---- Policy: enable flag, always-allowed apps, hard denylist --------------------------------------------------------
// Main owns this (src/main/computer/store.ts) and applies every change through applyComputerOp, from the window and
// anywhere else, so every field is checked. Computer Use is off until the user turns it on.

export const COMPUTER_LIMITS = { name: 200, allowed: 200 } as const;

export interface AllowedApp {
  bundleId: string;
  name: string;
  /** When the user chose "Always allow". */
  at: number;
}

export interface ComputerSettings {
  version: 1;
  enabled: boolean;
  alwaysAllowed: AllowedApp[];
}

export type ComputerOp =
  | { type: "enable" }
  | { type: "disable" }
  | { type: "allow-always"; bundleId: string; name: string }
  | { type: "revoke"; bundleId: string };

export class ComputerPolicyError extends Error {}

export const emptyComputerSettings = (): ComputerSettings => ({ version: 1, enabled: false, alwaysAllowed: [] });

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export const isBundleId = (value: unknown): value is string => typeof value === "string" && value.includes(".") && BUNDLE_ID.test(value);

export const PIGNA_BUNDLE_IDS = ["io.github.manuelcecchetto.pigna", "io.github.manuelcecchetto.pigna.dev"] as const;
export const HELPER_BUNDLE_ID = "io.github.manuelcecchetto.pigna.computeruse";

const TERMINAL = "Terminals can run anything; Computer Use never operates them";
const SECURITY = "macOS security and authentication prompts are never operated";
const OWN = "pi-gna and its helper are never operated by the agent";

/** Apps no approval can unlock, with the reason shown to the model and the user. */
export const DENYLIST: Readonly<Record<string, string>> = {
  "com.apple.Terminal": TERMINAL,
  "com.googlecode.iterm2": TERMINAL,
  "com.mitchellh.ghostty": TERMINAL,
  "com.github.wez.wezterm": TERMINAL,
  "net.kovidgoyal.kitty": TERMINAL,
  "org.alacritty": TERMINAL,
  "io.alacritty": TERMINAL,
  "dev.warp.Warp-Stable": TERMINAL,
  "dev.warp.Warp": TERMINAL,
  ...Object.fromEntries(PIGNA_BUNDLE_IDS.map((id) => [id, OWN])),
  [HELPER_BUNDLE_ID]: OWN,
  "com.apple.SecurityAgent": SECURITY,
  "com.apple.coreauthd": SECURITY,
  "com.apple.UserNotificationCenter": SECURITY,
  "com.apple.coreservices.uiagent": SECURITY,
  "com.apple.CoreServicesUIAgent": SECURITY,
  "com.apple.keychainaccess": SECURITY,
  "com.apple.ScreenSharing": SECURITY,
  "com.apple.loginwindow": SECURITY,
};

const DENIED_LOWER = new Map(Object.entries(DENYLIST).map(([id, reason]) => [id.toLowerCase(), reason]));

/** Why an app is off limits, or undefined. `extra` are runtime bundle ids (pi-gna's own, whatever app.getName() says);
 * `appPath` denies apps living inside pi-gna or the helper bundle (a renamed or dev build whose id is unknown). */
export function denyReason(bundleId: string, appPath?: string, extra: readonly string[] = []): string | undefined {
  const id = bundleId.toLowerCase();
  const known = DENIED_LOWER.get(id);
  if (known) return known;
  if (extra.some((other) => other.toLowerCase() === id)) return OWN;
  if (appPath && /(^|\/)(pi-gna[^/]*|pi-gna Computer Use)\.app(\/|$)/i.test(appPath)) return OWN;
  return undefined;
}

export const isDenied = (bundleId: string, appPath?: string, extra: readonly string[] = []): boolean => denyReason(bundleId, appPath, extra) !== undefined;

function appName(value: unknown): string {
  if (typeof value !== "string") throw new ComputerPolicyError("app name must be a string");
  const name = value.trim();
  if (!name || name.length > COMPUTER_LIMITS.name || /[\u0000-\u001f]/.test(name)) throw new ComputerPolicyError(`app name must be 1-${COMPUTER_LIMITS.name} printable characters`);
  return name;
}

function bundle(value: unknown): string {
  if (!isBundleId(value)) throw new ComputerPolicyError("invalid bundle id");
  return value;
}

/** Apply one change. Returns the same value when nothing changes. Throws ComputerPolicyError for an invalid op. */
export function applyComputerOp(settings: ComputerSettings, op: ComputerOp, now: number): ComputerSettings {
  switch (op?.type) {
    case "enable":
    case "disable": {
      const enabled = op.type === "enable";
      return settings.enabled === enabled ? settings : { ...settings, enabled };
    }
    case "allow-always": {
      const bundleId = bundle(op.bundleId);
      const name = appName(op.name);
      const reason = denyReason(bundleId);
      if (reason) throw new ComputerPolicyError(`${bundleId} cannot be allowed: ${reason}`);
      const existing = settings.alwaysAllowed.find((app) => app.bundleId === bundleId);
      if (existing) return existing.name === name ? settings : { ...settings, alwaysAllowed: settings.alwaysAllowed.map((app) => (app === existing ? { ...app, name } : app)) };
      if (settings.alwaysAllowed.length >= COMPUTER_LIMITS.allowed) throw new ComputerPolicyError(`at most ${COMPUTER_LIMITS.allowed} always-allowed apps`);
      return { ...settings, alwaysAllowed: [...settings.alwaysAllowed, { bundleId, name, at: now }] };
    }
    case "revoke": {
      const bundleId = bundle(op.bundleId);
      if (!settings.alwaysAllowed.some((app) => app.bundleId === bundleId)) return settings;
      return { ...settings, alwaysAllowed: settings.alwaysAllowed.filter((app) => app.bundleId !== bundleId) };
    }
    default:
      throw new ComputerPolicyError(`unknown op ${(op as { type?: unknown })?.type}`);
  }
}

/** Read settings back from disk. Throws when the file is not a settings object; skips malformed or denied apps. */
export function parseComputerSettings(raw: unknown): { settings: ComputerSettings; dropped: number } {
  const file = raw as { enabled?: unknown; alwaysAllowed?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new ComputerPolicyError("not a Computer Use settings object");
  const list = Array.isArray(file.alwaysAllowed) ? file.alwaysAllowed : [];
  const seen = new Set<string>();
  const alwaysAllowed: AllowedApp[] = [];
  let dropped = 0;
  for (const item of list as Partial<AllowedApp>[]) {
    try {
      const bundleId = bundle(item?.bundleId);
      if (denyReason(bundleId) || seen.has(bundleId) || alwaysAllowed.length >= COMPUTER_LIMITS.allowed) throw new ComputerPolicyError("skipped");
      seen.add(bundleId);
      alwaysAllowed.push({ bundleId, name: appName(item.name), at: typeof item.at === "number" && Number.isFinite(item.at) ? item.at : 0 });
    } catch {
      dropped++;
    }
  }
  return { settings: { version: 1, enabled: file.enabled === true, alwaysAllowed }, dropped };
}
