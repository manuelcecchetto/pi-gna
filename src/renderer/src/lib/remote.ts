// What Settings > Remote access shows from a RemoteStatus: the checks with their fixes, and the pairing link.
import type { RemoteStatus } from "../../../shared/host-api";

export interface RemoteCheck {
  label: string;
  ok: boolean;
  /** What is true now, or what to do. */
  detail: string;
  /** A link to the page that fixes it. */
  fix?: { label: string; url: string };
}

const TAILSCALE_DOWNLOAD = { label: "Get Tailscale", url: "https://tailscale.com/download/mac" };
const TAILSCALE_DNS = { label: "Open admin console", url: "https://login.tailscale.com/admin/dns" };

/** Status rows in the order the user fixes them. */
export function remoteChecks(status: RemoteStatus): RemoteCheck[] {
  const { tailscale } = status;
  return [
    status.listening
      ? { label: "Local server", ok: true, detail: `Listening on 127.0.0.1:${status.port}` }
      : { label: "Local server", ok: false, detail: status.error ?? (status.enabled ? "Not listening." : "Remote access is off.") },
    tailscale.installed
      ? { label: "Tailscale", ok: true, detail: "Installed" }
      : { label: "Tailscale", ok: false, detail: "Not installed. Install Tailscale on this Mac and your phone.", fix: TAILSCALE_DOWNLOAD },
    tailscale.loggedIn
      ? { label: "Signed in", ok: true, detail: tailscale.dnsName ?? "Connected" }
      : { label: "Signed in", ok: false, detail: tailscale.error ?? "Open Tailscale and sign in." },
    tailscale.httpsAvailable
      ? { label: "HTTPS certificates", ok: true, detail: "Enabled for your tailnet" }
      : { label: "HTTPS certificates", ok: false, detail: "Needed for the phone app. Enable HTTPS under DNS in the Tailscale admin console.", fix: TAILSCALE_DNS },
    status.serve === "funnel_refused"
      ? { label: "Funnel", ok: false, detail: "Funnel is on for this port, which is public. pi-gna will not serve until it is off: run `tailscale funnel --https=443 off`." }
      : { label: "Funnel", ok: true, detail: "Off" },
  ];
}

/** Whether `Serve over Tailscale` can be clicked, and why not. */
export function canServe(status: RemoteStatus): { ok: boolean; why?: string } {
  const failing = remoteChecks(status).find((check) => !check.ok && check.label !== "Local server");
  if (failing) return { ok: false, why: failing.detail };
  if (!status.listening) return { ok: false, why: status.error ?? "Turn remote access on first." };
  return { ok: true };
}

/** What the QR encodes: the tailnet URL, with the code in the fragment (never sent to a server). */
export const pairingLink = (url: string, code: string) => `${url}/#pair=${code}`;

/** `ABCD2345` shown as `ABCD 2345`. */
export const groupCode = (code: string) => code.replace(/(.{4})(?=.)/g, "$1 ");

/** A short device description from a user agent: "iPhone · Safari". */
export function describeAgent(userAgent: string): string {
  const device = /iPhone|iPad|Android|Macintosh|Windows/.exec(userAgent)?.[0] ?? "Unknown device";
  const browser = /CriOS/.test(userAgent) ? "Chrome" : /FxiOS/.test(userAgent) ? "Firefox" : /Safari/.test(userAgent) ? "Safari" : "";
  return browser ? `${device} · ${browser}` : device;
}
