// pi-gna's way into pi's logins, the ones pi's /login does. main (src/main/pi-auth.ts) runs this file with the `node`
// that runs pi, which strips its types: pi's SDK needs a newer Node than Electron's and has native modules. argv[2] is
// the folder of pi's package. One JSON record per line each way (AuthRequest in, AuthReply out); stdin closing ends it.
// With pi-claude-bridge installed, its claude-bridge provider signs in with Claude Code's own login (`claude auth`).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthEvent, AuthMethod, AuthPrompt, AuthProvider, AuthReply, AuthRequest, AuthState, AuthStatus } from "../src/shared/auth";

/** The parts of pi's SDK used here (ModelRuntime, as pi's interactive mode uses it for /login and /logout). */
interface Sdk {
  ModelRuntime: { create(): Promise<Runtime> };
  SettingsManager: { create(cwd: string, agentDir?: string): { getOrCreateDeviceId(): string } };
  /** Where pi installed the packages its settings list; absent from older pis. */
  DefaultPackageManager?: new (options: { cwd: string; agentDir: string; settingsManager: unknown }) => {
    listConfiguredPackages(): { scope: string; installedPath?: string }[];
  };
  getAgentDir(): string;
}

interface Runtime {
  getProviders(): { id: string; name: string; auth: { oauth?: { name: string; isSubscription?: boolean; loginLabel?: string }; apiKey?: { name: string; login?: unknown } } }[];
  getProviderAuthStatus(id: string): { configured: boolean; source?: string; label?: string };
  isUsingOAuth(id: string): boolean;
  listCredentials(options: { signal: AbortSignal }): Promise<{ providerId: string; type: AuthMethod }[]>;
  login(id: string, method: AuthMethod, interaction: Interaction, options: { getDeviceId(): string }): Promise<unknown>;
  logout(id: string, options: { signal: AbortSignal }): Promise<void>;
  refresh(options: { providers: string[]; signal: AbortSignal }): Promise<unknown>;
}

/** A prompt as pi's SDK asks it: AuthPrompt without its number, each kind of it. */
type SdkPrompt = { signal?: AbortSignal } & (AuthPrompt extends infer Kind ? (Kind extends AuthPrompt ? Omit<Kind, "n"> : never) : never);

interface Interaction {
  signal: AbortSignal;
  prompt(prompt: SdkPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

interface Login {
  controller: AbortController;
  prompts: Map<number, { resolve(value: string): void; reject(error: Error): void }>;
}

/** How pi reports a login you cancelled (an aborted prompt, or the aborted flow). */
const CANCELLED = /^(Login cancelled|This operation was aborted)$/;
/** CLAUDE_BRIDGE in src/shared/auth.ts (only its types are imported here). */
const CLAUDE_BRIDGE = "claude-bridge";

const send = (reply: AuthReply) => process.stdout.write(`${JSON.stringify(reply)}\n`);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const root = process.argv[2] ?? "";
const sdk = await import(pathToFileURL(join(root, "dist", "index.js")).href).then(
  (module) => module as Sdk,
  (error) => void send({ fatal: `pi-gna could not load pi's SDK from ${root}: ${message(error)}` }),
);
const logins = new Map<string, Login>();
let deviceId: string | undefined;
/** Claude Code processes running a sign-in, stopped with this process. */
const children = new Set<ChildProcess>();

async function list(sdk: Sdk): Promise<AuthState> {
  const runtime = await sdk.ModelRuntime.create();
  const stored = new Map((await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) })).map((credential) => [credential.providerId, credential.type]));
  const providers = runtime.getProviders().map((provider): AuthProvider => {
    const { oauth, apiKey } = provider.auth;
    const status = runtime.getProviderAuthStatus(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      ...(oauth && { oauth: { name: oauth.name, label: oauth.loginLabel, subscription: oauth.isSubscription === true } }),
      ...(apiKey && { apiKey: { name: apiKey.name, login: typeof apiKey.login === "function" } }),
      ...(status.configured && { status: { method: runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key", source: status.source ?? "", label: status.label } }),
      ...(stored.has(provider.id) && { stored: stored.get(provider.id) }),
    };
  });
  const claude = await claudeProvider(sdk);
  if (claude) providers.push(claude);
  return { providers: providers.sort((a, b) => a.name.localeCompare(b.name)), path: join(sdk.getAgentDir(), "auth.json") };
}

/** One login, as /login runs it: then the provider's model list is refreshed (15 s at most, failures ignored). */
async function login(sdk: Sdk, id: string, provider: string, method: AuthMethod): Promise<void> {
  const current: Login = { controller: new AbortController(), prompts: new Map() };
  logins.set(id, current);
  let count = 0;
  const prompt = ({ signal, ...question }: SdkPrompt) =>
    new Promise<string>((resolve, reject) => {
      const n = ++count;
      // The flow no longer needs this answer (say the browser sign-in finished first).
      const withdraw = () => {
        if (!current.prompts.delete(n)) return;
        send({ id, update: { kind: "withdraw", n } });
        reject(new Error("Login cancelled"));
      };
      current.prompts.set(n, {
        resolve: (value) => {
          current.prompts.delete(n);
          signal?.removeEventListener("abort", withdraw);
          resolve(value);
        },
        reject,
      });
      send({ id, update: { kind: "prompt", prompt: { ...question, n } as AuthPrompt } });
      if (signal?.aborted) withdraw();
      else signal?.addEventListener("abort", withdraw, { once: true });
    });
  try {
    if (provider === CLAUDE_BRIDGE) return await claudeLogin(sdk, id, current, prompt);
    const runtime = await sdk.ModelRuntime.create();
    const interaction: Interaction = { signal: current.controller.signal, prompt, notify: (event) => send({ id, update: { kind: "event", event } }) };
    await runtime.login(provider, method, interaction, { getDeviceId: () => (deviceId ??= sdk.SettingsManager.create(homedir()).getOrCreateDeviceId()) });
    send({ id, update: { kind: "event", event: { type: "progress", message: "Refreshing the model list…" } } });
    await runtime.refresh({ providers: [provider], signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  } catch (error) {
    throw Object.assign(new Error(message(error)), { cancelled: current.controller.signal.aborted || CANCELLED.test(message(error)) });
  } finally {
    logins.delete(id);
  }
}

function cancel(id: string): void {
  const current = logins.get(id);
  if (!current) return;
  const prompts = [...current.prompts.values()];
  current.prompts.clear();
  current.controller.abort();
  for (const prompt of prompts) prompt.reject(new Error("Login cancelled"));
}

async function logout(sdk: Sdk, provider: string): Promise<void> {
  if (provider === CLAUDE_BRIDGE) return claudeLogout(sdk);
  const runtime = await sdk.ModelRuntime.create();
  await runtime.logout(provider, { signal: AbortSignal.timeout(15_000) });
}

// ── Claude Code, for pi-claude-bridge ────────────────────────────────────────
// The bridge runs Claude models through Claude Code (the Agent SDK), so Claude Code's own login (its keychain item,
// shared by every Claude Code on this Mac) is what it uses, never pi's auth.json. Sign in and out run `claude auth`.

interface ClaudeStatus {
  loggedIn?: boolean;
  /** "claude.ai" for a Claude plan. */
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/** pi-claude-bridge's folder, when pi's user settings install it. */
function claudeBridge(sdk: Sdk): string | undefined {
  if (!sdk.DefaultPackageManager) return undefined;
  try {
    const agentDir = sdk.getAgentDir();
    const packages = new sdk.DefaultPackageManager({ cwd: homedir(), agentDir, settingsManager: sdk.SettingsManager.create(homedir(), agentDir) });
    return packages.listConfiguredPackages().find((pkg) => pkg.scope === "user" && pkg.installedPath && readJson(join(pkg.installedPath, "package.json"))?.name === "pi-claude-bridge")
      ?.installedPath;
  } catch {
    return undefined;
  }
}

/** The Claude Code the bridge runs: the one its claude-bridge.json names, else the Agent SDK's own binary, else `claude`. */
function claudeExecutable(sdk: Sdk, bridge: string): string {
  const configured = (readJson(join(sdk.getAgentDir(), "claude-bridge.json"))?.provider as { pathToClaudeCodeExecutable?: unknown } | undefined)?.pathToClaudeCodeExecutable;
  if (typeof configured === "string" && configured) return configured;
  // Where Node would resolve the SDK's platform package from the bridge.
  for (let dir = bridge; ; dir = dirname(dir)) {
    const binary = join(dir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
    if (existsSync(binary)) return binary;
    if (dirname(dir) === dir) return "claude";
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** claude-bridge as an account to sign in to, with Claude Code's login. */
async function claudeProvider(sdk: Sdk): Promise<AuthProvider | undefined> {
  const bridge = claudeBridge(sdk);
  if (!bridge) return undefined;
  const status = await claudeStatus(claudeExecutable(sdk, bridge));
  const signedIn: AuthStatus | undefined = status?.loggedIn
    ? status.authMethod === "claude.ai"
      ? { method: "oauth", source: "claude_code", label: status.subscriptionType }
      : { method: "api_key", source: "claude_code", label: status.authMethod }
    : undefined;
  return {
    id: CLAUDE_BRIDGE,
    name: "Claude Code",
    oauth: { name: "Claude Code (Claude subscription)", label: "Sign in with Claude Code's own login, which claude-bridge runs on", subscription: true },
    ...(signedIn && { status: signedIn, stored: "oauth" as const }),
    ...(signedIn && status?.email && { account: status.email }),
  };
}

/** `claude auth status`: JSON either way, exit code 1 when signed out. */
function claudeStatus(claude: string): Promise<ClaudeStatus | undefined> {
  return new Promise((resolve) => {
    execFile(claude, ["auth", "status", "--json"], { timeout: 15_000 }, (_error, stdout) => {
      try {
        resolve(JSON.parse(stdout) as ClaudeStatus);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** `claude auth login`, as in a terminal: Claude Code opens its sign-in page itself (which calls back to a local port)
 * and prints a fallback link, whose page shows a code to paste instead. */
function claudeLogin(sdk: Sdk, id: string, current: Login, prompt: (question: SdkPrompt) => Promise<string>): Promise<void> {
  const bridge = claudeBridge(sdk);
  if (!bridge) return Promise.reject(new Error("pi-claude-bridge is not installed"));
  const claude = claudeExecutable(sdk, bridge);
  return new Promise((resolve, reject) => {
    const child = spawn(claude, ["auth", "login", "--claudeai"], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    const exited = new AbortController();
    const kill = () => child.kill();
    current.controller.signal.addEventListener("abort", kill, { once: true });
    let stdout = "";
    let stderr = "";
    let shown = false;
    let asking = false;
    // A code pasted from the fallback page; Claude Code reports a wrong one on stderr and waits for another.
    const ask = (message: string) => {
      asking = true;
      prompt({ type: "manual_code", message, placeholder: "Paste the code", signal: exited.signal }).then(
        (code) => {
          asking = false;
          child.stdin.write(`${code.trim()}\n`);
          send({ id, update: { kind: "event", event: { type: "progress", message: "Signing in…" } } });
        },
        () => undefined,
      );
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // The link is wrapped in an OSC 8 hyperlink.
      const url = /visit:\s*(https:\/\/\S+)/.exec(stdout.replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[\d;?]*[A-Za-z]/g, ""))?.[1];
      if (!url || shown) return;
      shown = true;
      send({ id, update: { kind: "event", event: { type: "auth_url", url, opened: true } } });
      ask("If the page shows a code, paste it here");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
      if (/Invalid code/.test(chunk.toString()) && !asking) ask("That is not the whole code. Copy all of it from the page and paste it again.");
    });
    child.stdin.on("error", () => undefined);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      children.delete(child);
      current.controller.signal.removeEventListener("abort", kill);
      exited.abort();
      if (error) reject(error);
      else resolve();
    };
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? new Error(`Claude Code is not at ${claude}; claude-bridge needs it to sign in.`) : error),
    );
    child.on("close", (code) => finish(code === 0 ? undefined : new Error(lastLine(stderr) || `Claude Code's sign-in stopped (${code === null ? "cancelled" : `exit code ${code}`})`)));
  });
}

function claudeLogout(sdk: Sdk): Promise<void> {
  const bridge = claudeBridge(sdk);
  if (!bridge) return Promise.reject(new Error("pi-claude-bridge is not installed"));
  return new Promise((resolve, reject) => {
    execFile(claudeExecutable(sdk, bridge), ["auth", "logout"], { timeout: 15_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(lastLine(stderr) || error.message)) : resolve(),
    );
  });
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

function handle(sdk: Sdk, line: string): void {
  let request: AuthRequest;
  try {
    request = JSON.parse(line) as AuthRequest;
  } catch {
    return;
  }
  const { id } = request;
  if (request.op === "answer") return logins.get(id)?.prompts.get(request.n)?.resolve(String(request.value));
  if (request.op === "cancel") return cancel(id);
  const run =
    request.op === "list"
      ? list(sdk)
      : request.op === "login"
        ? login(sdk, id, request.provider, request.method)
        : request.op === "logout"
          ? logout(sdk, request.provider)
          : Promise.reject(new Error(`unknown request ${JSON.stringify((request as { op?: unknown }).op)}`));
  run.then(
    (value) => send({ id, ok: true, value }),
    (error: Error & { cancelled?: boolean }) => send({ id, ok: false, error: message(error), ...(error.cancelled && { cancelled: true }) }),
  );
}

if (sdk) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) handle(sdk, line);
    }
  });
  // main is done (or gone): cancel what runs, and do not let a provider's callback server keep this process alive.
  process.stdin.on("end", () => {
    for (const id of logins.keys()) cancel(id);
    setTimeout(() => process.exit(0), 2000).unref();
  });
  // Nor a Claude Code sign-in, which would wait for its browser: it stops with this process, killed or not.
  process.on("exit", () => {
    for (const child of children) child.kill();
  });
  process.on("SIGTERM", () => process.exit(0));
}
