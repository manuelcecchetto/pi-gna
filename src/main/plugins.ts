// The Settings page's Plugins section, in main: the catalog, and every change to what pi loads. Changes run in
// resources/pi-plugins.mts with pi's own SDK (one process per request, one change at a time); MCP status, sign-in and
// sign-out run pi's own `pi mcp list | login | logout`. Nothing is kept here: pi's settings.json and mcp.json are the
// state, so pi in the terminal and the chats started afterwards see every change. Token values never reach the log.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import {
  type Catalog,
  type CatalogConnection,
  type CatalogEntry,
  type CatalogPackage,
  type CatalogState,
  emptyPluginsState,
  type McpLoginResult,
  type McpLoginUpdate,
  type McpState,
  type McpStatusState,
  type PackageToggle,
  parseCatalog,
  type PluginToggle,
  type PluginsReply,
  type PluginsRequest,
  type PluginsState,
} from "../shared/plugins";
import { resolveCommand } from "./command";
import { log } from "./log";
import { findPiSdk } from "./pi-auth";

const STDERR_TAIL = 2000;
/** A change, or reading the state; installs have no limit (npm may be slow). */
const HELPER_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
/** How long `pi mcp login` waits for the browser. */
const LOGIN_TIMEOUT_S = 300;
const FETCH_TIMEOUT_MS = 8000;
/** An MCP token as a Keychain item can hold it through `security -i` (no quotes, spaces or line breaks). */
const TOKEN = /^[\w.~+/=:-]{8,512}$/;

export interface PiPluginsOptions {
  /** resources/pi-plugins.mts */
  script: string;
  /** resources/plugins/catalog.json */
  bundled: string;
  /** Where the last fetched catalog is kept (userData). */
  cache: string;
  /** The catalog's latest version, fetched once per launch. */
  remote: string;
  /** resources/recommended/AGENTS.md, the recommended setup's global AGENTS.md. */
  guide: string;
  onLogin(update: McpLoginUpdate): void;
  sdk?: () => string | undefined;
  node?: string;
  fetch?: typeof fetch;
}

const piBin = () => process.env.PIGNA_PI_BIN || "pi";

export class PiPlugins {
  private catalogLoad?: Promise<CatalogState>;
  /** Changes run one at a time, so two writes of settings.json never race. */
  private queue: Promise<unknown> = Promise.resolve();
  private login?: { server: string; child: ChildProcess; cancelled: boolean };
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly options: PiPluginsOptions) {}

  /** The catalog: fetched at the first call of a launch, else the copy fetched last time, else the bundled one. */
  catalog(): Promise<CatalogState> {
    this.catalogLoad ??= this.loadCatalog();
    return this.catalogLoad;
  }

  async state(cwd: string | undefined): Promise<PluginsState> {
    try {
      return (await this.helper({ op: "state", ...(cwd && { cwd }) })) as PluginsState;
    } catch (error) {
      return emptyPluginsState((error as Error).message);
    }
  }

  /** Each server's state as `pi mcp list` sees it; it connects to every enabled server (a second or so). */
  async status(cwd: string | undefined): Promise<McpStatusState> {
    const { stdout, stderr, code } = await this.pi(["mcp", "list", "--json"], cwd, STATUS_TIMEOUT_MS);
    try {
      const parsed = JSON.parse(stdout) as { servers?: { name: string; enabled?: boolean; state?: McpState; tools?: unknown[]; error?: string }[] };
      return {
        servers: Object.fromEntries(
          (parsed.servers ?? []).map((server) => [
            server.name,
            { state: server.enabled === false ? "disabled" : (server.state ?? "failed"), tools: server.tools?.length ?? 0, ...(server.error && { error: server.error }) },
          ]),
        ),
      };
    } catch {
      // `pi mcp list` exits 1 when a server fails, yet prints its JSON; no JSON at all is pi failing.
      return { servers: {}, error: lastLine(stderr) || `\`pi mcp list\` failed (exit code ${code ?? "?"})` };
    }
  }

  toggle(cwd: string | undefined, toggle: PluginToggle): Promise<void> {
    return this.change({ op: "toggle", ...(cwd && { cwd }), toggle });
  }

  togglePackage(cwd: string | undefined, toggle: PackageToggle): Promise<void> {
    return this.change({ op: "togglePackage", ...(cwd && { cwd }), toggle });
  }

  /** A catalog package, into your personal settings (`pi install`). */
  async install(id: string): Promise<void> {
    const entry = await this.entry(id, "package");
    log.info("plugins", `installing ${entry.source}`);
    await this.change({ op: "install", source: entry.source }, 0);
  }

  /** The recommended setup: the catalog's recommended packages you lack, codemode on unless you chose, and the guide
   * as your global AGENTS.md unless you have one. */
  async recommend(): Promise<void> {
    const sources = (await this.catalog()).catalog.entries.filter((entry): entry is CatalogPackage => entry.kind === "package" && entry.recommended === true).map((entry) => entry.source);
    log.info("plugins", `applying the recommended setup (${sources.join(", ")})`);
    await this.change({ op: "recommend", sources, guide: this.options.guide }, 0);
  }

  remove(cwd: string | undefined, source: string, scope: "user" | "project"): Promise<void> {
    log.info("plugins", `removing ${source} (${scope})`);
    return this.change({ op: "remove", ...(cwd && { cwd }), source, scope }, 0);
  }

  /** A catalog connection into the global mcp.json, at one of its endpoints. A token goes to the Keychain, and the
   * mcp.json header reads it from there each time pi connects (`!command`), so the file never holds it. */
  async connect(id: string, endpointId: string, token?: string): Promise<void> {
    const entry = await this.entry(id, "mcp");
    const endpoint = entry.endpoints.find((candidate) => candidate.id === endpointId);
    if (!endpoint) throw new Error(`${entry.name} has no endpoint ${endpointId}`);
    let headers: Record<string, string> | undefined;
    if (entry.auth.type === "key") {
      const value = token?.trim() ?? "";
      if (!TOKEN.test(value)) throw new Error(`That does not look like a ${entry.auth.label}. Paste it again, without spaces.`);
      await keychainSet(keychainService(entry.server), value);
      headers = { Authorization: `!echo "Bearer $(security find-generic-password -s '${keychainService(entry.server)}' -w)"` };
    }
    log.info("plugins", `adding MCP server ${entry.server} (${endpoint.url})`);
    await this.change({ op: "mcpAdd", name: entry.server, url: endpoint.url, ...(headers && { headers }) });
  }

  /** Removes a server from its mcp.json, after signing it out (OAuth) or deleting its Keychain token (catalog key). */
  async disconnect(cwd: string | undefined, server: string, scope: "global" | "project"): Promise<void> {
    const catalog = (await this.catalog()).catalog;
    const entry = catalog.entries.find((candidate): candidate is CatalogConnection => candidate.kind === "mcp" && candidate.server === server);
    if (scope === "global" && entry?.auth.type === "key") await keychainDelete(keychainService(server));
    else await this.pi(["mcp", "logout", server], cwd, STATUS_TIMEOUT_MS);
    log.info("plugins", `removing MCP server ${server} (${scope})`);
    await this.change({ op: "mcpRemove", ...(cwd && { cwd }), name: server, scope });
  }

  enableServer(cwd: string | undefined, server: string, scope: "global" | "project", enabled: boolean): Promise<void> {
    return this.change({ op: "mcpEnable", ...(cwd && { cwd }), name: server, scope, enabled });
  }

  /** `pi mcp login`: pi opens the sign-in page and waits for the browser's callback; the page's URL is pushed so the
   * window can offer it again. A new sign-in cancels the last. */
  async signIn(server: string, cwd: string | undefined): Promise<McpLoginResult> {
    this.cancelSignIn();
    const child = this.spawnPi(["mcp", "login", server, "--timeout", String(LOGIN_TIMEOUT_S)], cwd);
    const current = { server, child, cancelled: false };
    this.login = current;
    let stdout = "";
    let stderr = "";
    let shown = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const url = /^(https:\/\/\S+)$/m.exec(stdout)?.[1];
      if (url && !shown) {
        shown = true;
        this.options.onLogin({ server, url });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    const code = await exited(child);
    if (this.login === current) this.login = undefined;
    if (current.cancelled) return { ok: false, cancelled: true };
    return code === 0 ? { ok: true } : { ok: false, error: lastLine(stderr) || `\`pi mcp login\` stopped (exit code ${code ?? "?"})` };
  }

  cancelSignIn(): void {
    if (!this.login) return;
    this.login.cancelled = true;
    this.login.child.kill();
    this.login = undefined;
  }

  /** Deletes the server's stored OAuth credentials (`pi mcp logout`). */
  async signOut(server: string, cwd: string | undefined): Promise<void> {
    const { code, stderr } = await this.pi(["mcp", "logout", server], cwd, STATUS_TIMEOUT_MS);
    if (code !== 0) throw new Error(lastLine(stderr) || `\`pi mcp logout\` failed (exit code ${code ?? "?"})`);
  }

  /** At quit. */
  close(): void {
    this.cancelSignIn();
    for (const child of this.children) child.kill();
  }

  private async entry<K extends CatalogEntry["kind"]>(id: string, kind: K): Promise<Extract<CatalogEntry, { kind: K }>> {
    const entry = (await this.catalog()).catalog.entries.find((candidate) => candidate.id === id);
    if (entry?.kind !== kind) throw new Error(`The catalog has no ${kind === "mcp" ? "connection" : "package"} ${id}`);
    return entry as Extract<CatalogEntry, { kind: K }>;
  }

  private async loadCatalog(): Promise<CatalogState> {
    const { remote, cache, bundled } = this.options;
    try {
      const response = await (this.options.fetch ?? fetch)(remote, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = parseCatalog(await response.json());
      try {
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify(catalog));
      } catch (error) {
        log.warn("plugins", `could not keep the catalog: ${(error as Error).message}`);
      }
      return { catalog, origin: "remote" };
    } catch (error) {
      log.info("plugins", `using a local catalog (${(error as Error).message})`);
    }
    const cached = readCatalog(cache);
    if (cached) return { catalog: cached, origin: "cache" };
    const shipped = readCatalog(bundled);
    if (!shipped) throw new Error("pi-gna's bundled plugin catalog is unreadable");
    return { catalog: shipped, origin: "bundled" };
  }

  private change(request: PluginsRequest, timeoutMs = HELPER_TIMEOUT_MS): Promise<void> {
    const run = this.queue.then(() => this.helper(request, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run.then(() => undefined);
  }

  /** One run of the helper: the request on stdin, the reply on fd 3. */
  private helper(request: PluginsRequest, timeoutMs = HELPER_TIMEOUT_MS): Promise<unknown> {
    const sdk = (this.options.sdk ?? (() => findPiSdk(piBin())))();
    if (!sdk) return Promise.reject(new Error(`pi-gna could not find pi's SDK next to \`${piBin()}\`. Install pi with \`npm install -g @earendil-works/pi-coding-agent\`.`));
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.node ?? "node", [this.options.script, sdk], { cwd: homedir(), env: process.env, stdio: ["pipe", "ignore", "pipe", "pipe"] });
      this.children.add(child);
      let reply = "";
      let stderr = "";
      const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined;
      (child.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => (reply += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL)));
      child.stdin?.on("error", () => undefined);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(new Error(error.code === "ENOENT" ? "`node` is not on your PATH, so pi-gna cannot run pi's plugin helper." : `pi's plugin helper failed: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        let parsed: PluginsReply | undefined;
        try {
          parsed = JSON.parse(reply) as PluginsReply;
        } catch {
          const tail = lastLine(stderr);
          if (tail) log.warn("plugins", tail);
          reject(new Error(`pi's plugin helper stopped (${signal ?? `exit code ${code}`})${tail ? `: ${tail}` : ""}`));
          return;
        }
        if (parsed.ok) resolve(parsed.value);
        else reject(new Error(parsed.error));
      });
      child.stdin?.end(JSON.stringify(request));
    });
  }

  private spawnPi(args: string[], cwd: string | undefined): ChildProcess {
    const command = resolveCommand(piBin(), args);
    const child = spawn(command.file, command.args, { cwd: cwd ?? homedir(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    child.on("close", () => this.children.delete(child));
    child.on("error", () => this.children.delete(child));
    return child;
  }

  private async pi(args: string[], cwd: string | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const child = this.spawnPi(args, cwd);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const code = await exited(child);
    clearTimeout(timer);
    return { stdout, stderr, code };
  }
}

function readCatalog(file: string): Catalog | undefined {
  try {
    return parseCatalog(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      log.warn("plugins", error.code === "ENOENT" ? `\`${piBin()}\` is not on the PATH` : error.message);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

/** The Keychain item of a catalog connection's token. */
export const keychainService = (server: string) => `pi-gna.mcp.${server}`;

/** Through `security -i` on stdin, so the token is never in a process's arguments. */
function keychainSet(service: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Could not save the token in the Keychain: ${lastLine(stderr) || `exit code ${code}`}`))));
    child.stdin.end(`add-generic-password -U -a "${userInfo().username}" -s "${service}" -l "${service}" -w "${token}"\n`);
  });
}

function keychainDelete(service: string): Promise<void> {
  // A token already gone is fine.
  return new Promise((resolve) => execFile("/usr/bin/security", ["delete-generic-password", "-s", service], () => resolve()));
}
