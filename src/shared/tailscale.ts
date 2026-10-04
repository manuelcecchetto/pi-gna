// Tailscale's CLI as pure helpers: how its JSON becomes our status, and the exact commands pi-gna may run.
// Nothing here runs a process (main/tailscale.ts does). pi-gna only ever publishes on the tailnet with
// `tailscale serve`; it never builds a Funnel command (REMOTE.md s.12).

/** The Tailscale app's own CLI, used when `tailscale` is not on the login shell's PATH. */
export const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** The HTTPS port `tailscale serve` listens on for the tailnet. */
export const SERVE_PORT = 443;

export interface TailscaleStatus {
  /** The CLI was found. */
  installed: boolean;
  /** Signed in and connected (BackendState Running). */
  loggedIn: boolean;
  /** `<mac>.<tailnet>.ts.net`, no trailing dot. */
  dnsName?: string;
  /** The tailnet has HTTPS certificates enabled (needed by `tailscale serve --https`). */
  httpsAvailable: boolean;
  /** What :443 forwards to now, if anything. */
  serving?: { target: string };
  /** Funnel (the public internet) is on for :443. */
  funnel: boolean;
  /** Why the status is partial (CLI error, bad JSON); shown beside the fix. */
  error?: string;
}

export const noTailscale = (error?: string): TailscaleStatus => ({ installed: false, loggedIn: false, httpsAvailable: false, funnel: false, ...(error ? { error } : {}) });

const object = (value: unknown): Record<string, any> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {});

/** `tailscale status --json`: sign-in state, DNS name, whether HTTPS certificates are available. */
export function parseStatus(json: string): Pick<TailscaleStatus, "loggedIn" | "dnsName" | "httpsAvailable"> {
  const raw = object(JSON.parse(json));
  const self = object(raw.Self);
  const dnsName = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  const domains = Array.isArray(raw.CertDomains) ? raw.CertDomains : [];
  const capabilities = Array.isArray(self.Capabilities) ? self.Capabilities : Object.keys(object(self.CapMap));
  return {
    loggedIn: raw.BackendState === "Running",
    ...(dnsName ? { dnsName } : {}),
    httpsAvailable: domains.length > 0 || capabilities.includes("https"),
  };
}

/** `tailscale serve status --json`: the :443 web mapping and whether Funnel is on for it. `{}` means nothing is served. */
export function parseServe(json: string): Pick<TailscaleStatus, "serving" | "funnel"> {
  const raw = object(JSON.parse(json || "{}"));
  const port = `:${SERVE_PORT}`;
  const onPort = (key: string) => key.endsWith(port);
  const funnel = Object.entries(object(raw.AllowFunnel)).some(([key, on]) => onPort(key) && on === true);
  const web = Object.entries(object(raw.Web)).find(([key]) => onPort(key));
  const target = object(object(object(web?.[1]).Handlers)["/"]).Proxy;
  // A :443 mapping that is not a plain proxy on "/" still counts as taken, so it is never overwritten.
  const serving = web ? { target: typeof target === "string" ? target : "(other)" } : undefined;
  return { funnel, ...(serving ? { serving } : {}) };
}

export const proxyTarget = (port: number) => `http://127.0.0.1:${port}`;
/** Whether :443 forwards to this pi-gna's port (Tailscale prints the target with or without a trailing slash). */
export const servesPort = (status: Pick<TailscaleStatus, "serving">, port: number) => status.serving?.target.replace(/\/$/, "") === proxyTarget(port);

/** The arguments `Serve over Tailscale` runs. */
export const serveArgs = (port: number): string[] => ["serve", "--bg", `--https=${SERVE_PORT}`, proxyTarget(port)];
/** The arguments `Stop serving` runs. */
export const unserveArgs = (): string[] => ["serve", `--https=${SERVE_PORT}`, "off"];

export const FUNNEL_REFUSED = "Funnel is on for this Tailscale port, which would expose pi-gna to the public internet. Turn it off (tailscale funnel --https=443 off) and try again.";

/** Why `Serve over Tailscale` cannot run now; undefined when it can. The tailnet is never changed in these cases. */
export function serveBlocker(status: TailscaleStatus, port: number): string | undefined {
  if (!status.installed) return "Tailscale is not installed.";
  if (!status.loggedIn) return "Sign in to Tailscale first.";
  if (!status.httpsAvailable) return "Turn on HTTPS certificates for your tailnet (Tailscale admin console > DNS).";
  if (status.funnel) return FUNNEL_REFUSED;
  if (status.serving && !servesPort(status, port)) return `Tailscale already serves ${status.serving.target} on port ${SERVE_PORT}; pi-gna will not replace it.`;
  return undefined;
}

/** Why `Stop serving` cannot run; only a mapping to this pi-gna is ever turned off. */
export function unserveBlocker(status: TailscaleStatus, port: number): string | undefined {
  if (!status.installed) return "Tailscale is not installed.";
  if (status.serving && !servesPort(status, port)) return `Port ${SERVE_PORT} does not forward to pi-gna; not turning it off.`;
  return undefined;
}

/** The CLI to run: `tailscale` from the PATH directories, else the app's own. */
export function findCli(pathEnv: string | undefined, exists: (file: string) => boolean): string | undefined {
  for (const dir of (pathEnv ?? "").split(":")) if (dir && exists(`${dir}/tailscale`)) return `${dir}/tailscale`;
  return exists(TAILSCALE_APP_CLI) ? TAILSCALE_APP_CLI : undefined;
}

/** The serve state clients show, from the tailscale status. */
export function serveState(status: TailscaleStatus, port: number): "off" | "on" | "funnel_refused" | "unavailable" {
  if (!status.installed || !status.loggedIn) return "unavailable";
  if (status.funnel) return "funnel_refused";
  return servesPort(status, port) ? "on" : "off";
}

/** Hosts the remote server accepts: the tailnet name, and loopback names only for local testing. */
export function allowedHosts(dnsName: string | undefined, port: number, loopback: boolean): string[] {
  return [...(dnsName ? [dnsName] : []), ...(loopback ? [`127.0.0.1:${port}`, `localhost:${port}`] : [])];
}
