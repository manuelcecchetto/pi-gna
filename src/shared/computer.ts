// Wire protocol between Electron main and the native "pi-gna Computer Use" helper (docs/COMPUTER_USE.md).
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
  screenshot: [{ app: string | AppTarget }, { jpeg: string; width: number; height: number; scale: number }];
  begin_session: [{ session: string; target: AppTarget; label: string }, Record<string, never>];
  end_session: [{ session: string }, Record<string, never>];
  cancel: [{ session: string }, Record<string, never>];
  click: [{ target: AppTarget; session: string; elementIndex?: number; x?: number; y?: number; button?: "left" | "right" | "middle"; clickCount?: number }, { method: "ax" | "cgevent" | "hid"; settled: boolean }];
  type_text: [{ target: AppTarget; session: string; text: string }, Record<string, never>];
  press_key: [{ target: AppTarget; session: string; key: string }, Record<string, never>];
  shutdown: [Record<string, never>, Record<string, never>];
}

export type ComputerMethod = keyof ComputerMethods;

export interface ComputerNotifications {
  cancelled: { session: string; reason: "esc" };
  permissions_changed: Permissions;
  app_gone: { session: string; bundleId: string };
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
