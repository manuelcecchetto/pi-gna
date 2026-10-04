// Pure helpers and the network steps of pairing (docs/REMOTE.md section 11); the screen is components/Pairing.tsx.
import { HEADER_CLIENT, PAIRING_CODE_LENGTH, type DeviceInfo, type HostErrorBody } from "../shared/host-api";

/** Uppercases and drops separators so "abcd-2345" and "ABCD 2345" both work; the host only ever issues [A-Z2-9]. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, PAIRING_CODE_LENGTH);
}

/** The code carried by a QR link: `<url>/#pair=<code>`. Empty when absent or malformed. */
export function codeFromHash(hash: string): string {
  const match = /(?:^|[#&])pair=([^&]*)/.exec(hash);
  if (!match) return "";
  let raw = match[1]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep the raw text
  }
  const code = normalizeCode(raw);
  return code.length === PAIRING_CODE_LENGTH ? code : "";
}

/** A readable default name from the user agent ("iPhone", "iPad", "Android phone", "Mac", ...). */
export function defaultDeviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(userAgent)) return "Mac browser";
  if (/Windows/.test(userAgent)) return "Windows browser";
  if (/Linux/.test(userAgent)) return "Linux browser";
  return "Phone";
}

/** True inside the installed Home Screen app (iOS `navigator.standalone` or the display-mode media query). */
export function isStandalone(nav: { standalone?: boolean }, matches: (query: string) => boolean): boolean {
  return nav.standalone === true || matches("(display-mode: standalone)");
}

export type PairFailure = "wrong_code" | "locked" | "rate_limited" | "expired" | "denied" | "unreachable";

export type PairOutcome = { ok: true } | { ok: false; failure: PairFailure; retryAfter?: number };

export interface PairDeps {
  fetch: typeof fetch;
  /** Called with the request id once the Mac has been asked, before waiting. */
  onPending?: () => void;
  /** Stops the wait (the user pressed Cancel). */
  signal?: AbortSignal;
}

const post = (deps: PairDeps, body: unknown) =>
  deps.fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json", [HEADER_CLIENT]: "1" }, body: JSON.stringify(body), signal: deps.signal });

/** Submits the code, then long-polls until the Mac allows or denies. The cookie arrives on the allowing response. */
export async function pair(code: string, deviceName: string, deps: PairDeps): Promise<PairOutcome> {
  try {
    const response = await post(deps, { code, deviceName });
    if (!response.ok) {
      const error = ((await response.json().catch(() => ({}))) as { error?: HostErrorBody }).error;
      if (error?.code === "rate_limited") {
        const retryAfter = Number(error.detail?.retryAfter) || undefined;
        return { ok: false, failure: /locked/.test(error.message) ? "locked" : "rate_limited", retryAfter };
      }
      return { ok: false, failure: error?.code === "bad_request" ? "wrong_code" : "unreachable" };
    }
    const { request } = (await response.json()) as { request: string };
    deps.onPending?.();
    for (;;) {
      const wait = await deps.fetch(`/api/pair/${encodeURIComponent(request)}/wait`, { cache: "no-store", signal: deps.signal });
      if (!wait.ok) return { ok: false, failure: "unreachable" };
      const { state } = (await wait.json()) as { state: string };
      if (state === "approved") return { ok: true };
      if (state === "denied") return { ok: false, failure: "denied" };
      if (state !== "pending_approval") return { ok: false, failure: "expired" };
    }
  } catch {
    return { ok: false, failure: "unreachable" };
  }
}

/** Revokes this device on the host; its cookie stops working at once. */
export async function signOutThisDevice(fetcher: typeof fetch): Promise<boolean> {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await fetcher(`/api/call/${method}`, { method: "POST", headers: { "content-type": "application/json", [HEADER_CLIENT]: "1", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(args) });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as T;
  };
  try {
    const devices = await call<DeviceInfo[]>("devices.list", {});
    const self = devices.find((d) => d.current);
    if (!self) return false;
    await call("devices.revoke", { id: self.id });
    return true;
  } catch {
    return false;
  }
}
