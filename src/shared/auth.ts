// pi's provider logins, the way pi's /login does them. pi's RPC mode has no login, so main runs resources/pi-auth.mts
// with pi's own SDK (ModelRuntime) and the Settings page's Providers section drives it. These are the records that
// pass between them, and what the page shows of them.

export type AuthMethod = "oauth" | "api_key";

/** pi-claude-bridge's provider: Claude through Claude Code, signed in with Claude Code's own login (`claude auth`). */
export const CLAUDE_BRIDGE = "claude-bridge";

/** One of pi's providers, and how pi authenticates to it now. */
export interface AuthProvider {
  id: string;
  name: string;
  /** Sign in with an account, e.g. "Anthropic (Claude Pro/Max)"; a subscription when it is a paid plan. */
  oauth?: { name: string; label?: string; subscription: boolean };
  /** An API key; `login` false when pi only reads it from the environment or models.json. */
  apiKey?: { name: string; login: boolean };
  status?: AuthStatus;
  /** The credential Sign out removes: pi's auth.json, or Claude Code's login for claude-bridge. Environment variables
   * and models.json stay. */
  stored?: AuthMethod;
  /** Who is signed in, when the login says (Claude Code's email). */
  account?: string;
}

/** pi's ModelRuntime.getProviderAuthStatus for a configured provider. */
export interface AuthStatus {
  method: AuthMethod;
  /** "stored" (auth.json), "environment", "models_json_key", "models_json_command", "runtime" or "fallback"; for
   * claude-bridge, "claude_code". */
  source: string;
  /** The environment variables, for source "environment"; the Claude plan ("max"), for "claude_code". */
  label?: string;
}

export interface AuthState {
  providers: AuthProvider[];
  /** pi's auth.json. */
  path?: string;
  /** Why pi-gna cannot reach pi's logins: no pi on the PATH, an SDK it cannot load. */
  error?: string;
}

/** A question pi's login asks; `n` numbers them within one login. */
export type AuthPrompt = { n: number; message: string } & (
  | { type: "text" | "secret" | "manual_code"; placeholder?: string }
  | { type: "select"; options: { id: string; label: string; description?: string }[] }
);

export type AuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  /** `opened`: the login opened a page in the browser itself (Claude Code), and `url` is its fallback. */
  | { type: "auth_url"; url: string; instructions?: string; opened?: boolean }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

/** What a running login tells the page. `withdraw`: a prompt is no longer needed (the browser finished first). */
export type LoginUpdate = { kind: "event"; event: AuthEvent } | { kind: "prompt"; prompt: AuthPrompt } | { kind: "withdraw"; n: number };

export type LoginResult = { ok: true } | { ok: false; cancelled: boolean; error: string };

/** main → the helper, one JSON record per line. `answer` and `cancel` name the login by its id. */
export type AuthRequest =
  | { id: string; op: "list" }
  | { id: string; op: "login"; provider: string; method: AuthMethod }
  | { id: string; op: "logout"; provider: string }
  | { id: string; op: "answer"; n: number; value: string }
  | { id: string; op: "cancel" };

/** The helper → main. `fatal`: it could not load pi's SDK, and exits. */
export type AuthReply =
  | { id: string; ok: true; value?: unknown }
  | { id: string; ok: false; error: string; cancelled?: boolean }
  | { id: string; update: LoginUpdate }
  | { fatal: string };

export type StatusTone = "on" | "other" | "off";

/** A provider's status for one way of signing in: on when pi uses it, other when pi authenticates another way. */
export function authStatus(provider: AuthProvider, method: AuthMethod): { text: string; tone: StatusTone } {
  const status = provider.status;
  if (!status) return { text: "Not connected", tone: "off" };
  if (status.source === "claude_code") {
    const plan = status.label ? ` · Claude ${status.label.slice(0, 1).toUpperCase()}${status.label.slice(1)}` : "";
    return status.method === "oauth" ? { text: `Signed in${plan}`, tone: "on" } : { text: "Claude Code uses an API key", tone: "other" };
  }
  const text =
    status.source === "stored"
      ? status.method === "oauth"
        ? "Signed in"
        : "Key saved"
      : status.source === "environment"
        ? `From ${status.label ?? "the environment"}`
        : status.source.startsWith("models_json")
          ? "From models.json"
          : "Configured";
  if (status.method === method) return { text, tone: "on" };
  return { text: status.method === "oauth" ? "Signed in with an account" : status.source === "stored" ? "Uses an API key" : text, tone: "other" };
}

/** Why the Claude Code card can neither sign in nor out: Claude Code uses a key or token from the environment (or an
 * apiKeyHelper), which wins over its own login. pi-gna reads the shell's environment once, at start. */
export function claudeFromEnvironment(provider: AuthProvider): string | undefined {
  if (provider.id !== CLAUDE_BRIDGE || provider.status?.source !== "environment") return undefined;
  return `Claude Code uses ${provider.status.label ?? "a key from the environment"} instead of its own login. Remove it from your shell profile (or Claude Code's settings), then quit and reopen pi-gna to sign in with your plan.`;
}

/** Account sign-ins first (subscriptions before the rest), then every provider that takes an API key. pi's own
 * Anthropic account login never gets a card, bridge or not: a Claude plan signs in through Claude Code (claude-bridge),
 * the safer way. `piClaude` is that login while pi still has one saved, to sign out of. */
export function splitProviders(providers: AuthProvider[]): { accounts: AuthProvider[]; keys: AuthProvider[]; piClaude?: AuthProvider } {
  const anthropic = providers.find((provider) => provider.id === "anthropic");
  const accounts = providers.filter((provider) => provider.oauth && provider !== anthropic);
  accounts.sort((a, b) => Number(b.oauth?.subscription) - Number(a.oauth?.subscription));
  const piClaude = anthropic?.stored === "oauth" ? anthropic : undefined;
  return { accounts, keys: providers.filter((provider) => provider.apiKey), ...(piClaude && { piClaude }) };
}

/** Providers whose name, id or key name has every word of the query; connected ones first. */
export function searchProviders(providers: AuthProvider[], query: string): AuthProvider[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = providers.filter((provider) => {
    const text = `${provider.name} ${provider.id} ${provider.apiKey?.name ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  return [...found.filter((provider) => provider.status), ...found.filter((provider) => !provider.status)];
}
