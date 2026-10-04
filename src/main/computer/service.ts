// Owns the native Computer Use helper's lifecycle (docs/DESIGN.md, "Computer Use"): install the bundled
// app to ~/.pi-gna/computer-use/ (only when its PigCUHelperVersion is newer, so macOS permission grants survive
// pi-gna updates; when its signature identity changes too, clear the grants it cannot match), launch it through LaunchServices, connect to its Unix socket, authenticate, and expose a
// typed JSON-RPC client. Starts lazily, restarts after a crash on the next call, stops on app quit.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { COMPUTER_PROTOCOL, ComputerError, ComputerErrorCode, HELPER_BUNDLE_ID, type ComputerMethod, type ComputerMethods, type ComputerNotification, type HelloResult } from "../../shared/computer";
import { log } from "../log";
import { CALL_TIMEOUT_MS, RpcClient } from "./rpc";

const run = promisify(execFile);
export const HELPER_APP = "pi-gna Computer Use.app";
/** sun_path is 104 bytes on macOS; leave room for the name. */
const MAX_SOCKET_PATH = 100;

export interface ComputerServiceDeps {
  /** Built helper inside the pi-gna bundle (or build/computer-use in a checkout). */
  bundledApp: string;
  /** Where the helper is installed; defaults to ~/.pi-gna/computer-use. */
  installDir: string;
  /** Preferred socket folder (app.getPath("userData")); falls back to tmpdir when the path is too long. */
  socketDir: string;
  parentPid: number;
  /** Launch the installed app with these argv through LaunchServices. */
  launch(appPath: string, args: string[]): Promise<void>;
  /** PigCUHelperVersion of an app bundle, undefined when missing. */
  readVersion(appPath: string): Promise<number | undefined>;
  /** Replace `to` with a copy of `from`. */
  install(from: string, to: string): Promise<void>;
  /** The app's code-signing designated requirement, undefined when missing or unsigned. */
  readRequirement(appPath: string): Promise<string | undefined>;
  /** Forget the helper's Accessibility and Screen Recording grants. */
  resetGrants(): Promise<void>;
  connectTimeoutMs: number;
  callTimeoutMs: number;
}

export const defaultDeps = (bundledApp: string, socketDir: string): ComputerServiceDeps => ({
  bundledApp,
  installDir: join(homedir(), ".pi-gna", "computer-use"),
  socketDir,
  parentPid: process.pid,
  launch: async (appPath, args) => void (await run("open", ["-g", "-n", "-a", appPath, "--args", ...args])),
  readVersion: async (appPath) => {
    const plist = await readFile(join(appPath, "Contents", "Info.plist"), "utf8").catch(() => undefined);
    const version = plist && /<key>PigCUHelperVersion<\/key>\s*<(?:integer|string)>(\d+)</.exec(plist)?.[1];
    return version ? Number(version) : undefined;
  },
  install: async (from, to) => {
    await rm(to, { recursive: true, force: true });
    await mkdir(join(to, ".."), { recursive: true });
    await run("ditto", [from, to]);
  },
  readRequirement: async (appPath) => {
    const out = await run("codesign", ["-d", "-r", "-", appPath]).catch(() => undefined);
    return out && /^(?:# )?designated => (.+)$/m.exec(`${out.stdout}\n${out.stderr}`)?.[1];
  },
  resetGrants: async () => {
    for (const service of ["Accessibility", "ScreenCapture"]) {
      await run("tccutil", ["reset", service, HELPER_BUNDLE_ID]).catch((error) => log.warn("computer", `tccutil reset ${service}: ${error instanceof Error ? error.message : error}`));
    }
  },
  connectTimeoutMs: 5000,
  callTimeoutMs: CALL_TIMEOUT_MS,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ComputerService {
  private client: RpcClient | undefined;
  private starting: Promise<RpcClient> | undefined;
  private hello: HelloResult | undefined;
  private listeners = new Set<(notification: ComputerNotification) => void>();
  private stopped = false;
  private crashed = false;

  constructor(private readonly deps: ComputerServiceDeps) {}

  /** Where the helper runs from: what to add by hand under Screen & System Audio Recording. */
  get installedApp(): string {
    return join(this.deps.installDir, HELPER_APP);
  }

  /** Subscribe to helper notifications (`cancelled`, `permissions_changed`, `app_gone`). Returns an unsubscribe. */
  onNotification(listener: (notification: ComputerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Typed call; starts the helper on first use and again after a crash. */
  async call<M extends ComputerMethod>(method: M, params: ComputerMethods[M][0], timeoutMs = this.deps.callTimeoutMs): Promise<ComputerMethods[M][1]> {
    const client = await this.ensureStarted();
    return client.call(method, params, timeoutMs);
  }

  /** Handshake result of the running helper (starts it if needed). */
  async info(): Promise<HelloResult> {
    await this.ensureStarted();
    return this.hello as HelloResult;
  }

  /** Ask the helper to exit, then make sure it did. Safe to call repeatedly; later calls start it again. */
  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client ?? (await this.starting?.catch(() => undefined));
    const pid = this.hello?.pid;
    this.client = undefined;
    this.starting = undefined;
    if (!client) return;
    await client.call("shutdown", {}, 1500).catch(() => undefined);
    client.close();
    if (pid) {
      await sleep(100);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  private ensureStarted(): Promise<RpcClient> {
    this.stopped = false;
    if (this.client) return Promise.resolve(this.client);
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<RpcClient> {
    const { deps } = this;
    const installed = this.installedApp;
    const [bundled, current] = await Promise.all([deps.readVersion(deps.bundledApp), deps.readVersion(installed)]);
    if (bundled === undefined) log.warn("computer", `helper missing at ${deps.bundledApp}; run \`pnpm build:computer-use\` in a checkout`);
    if (bundled === undefined) throw new ComputerError(ComputerErrorCode.appNotFound, `Computer Use helper is missing from this build (${deps.bundledApp})`);
    if (current === undefined || bundled > current) {
      log.info("computer", `installing helper v${bundled} to ${installed}${current === undefined ? "" : ` (was v${current})`}`);
      const [before, after] = await Promise.all([deps.readRequirement(installed), deps.readRequirement(deps.bundledApp)]);
      await deps.install(deps.bundledApp, installed);
      // macOS checks a grant against the requirement recorded when it was given; a new one (an ad-hoc rebuild, a new
      // certificate) fails it while System Settings still shows the switch on. Clear them so macOS asks again.
      if (before !== after) {
        log.info("computer", "helper signature changed; resetting its Accessibility and Screen Recording grants");
        await deps.resetGrants();
      }
    }

    const launchId = randomBytes(4).toString("hex");
    const token = randomBytes(24).toString("hex");
    const dir = join(deps.socketDir, `cu-${launchId}.sock`).length <= MAX_SOCKET_PATH ? deps.socketDir : tmpdir();
    const socketPath = join(dir, `cu-${launchId}.sock`);
    await mkdir(dir, { recursive: true });
    await rm(socketPath, { force: true });
    await deps.launch(installed, ["--socket", socketPath, "--token", token, "--parent", String(deps.parentPid)]);

    const socket = await this.connect(socketPath);
    const client = new RpcClient(
      socket,
      (notification) => {
        for (const listener of this.listeners) listener(notification);
      },
      () => this.lost(client),
    );
    try {
      this.hello = await client.call("hello", { token, protocol: COMPUTER_PROTOCOL }, deps.callTimeoutMs);
    } catch (error) {
      client.close();
      throw error;
    }
    if (this.hello.protocol !== COMPUTER_PROTOCOL) {
      client.close();
      throw new ComputerError(ComputerErrorCode.actionFailed, `Computer Use helper speaks protocol ${this.hello.protocol}, expected ${COMPUTER_PROTOCOL}`);
    }
    if (this.crashed) log.info("computer", "helper restarted after a crash");
    this.crashed = false;
    this.client = client;
    log.info("computer", `helper ready (v${this.hello.helperVersion}, pid ${this.hello.pid ?? "?"})`);
    return client;
  }

  private async connect(path: string): Promise<Socket> {
    const deadline = Date.now() + this.deps.connectTimeoutMs;
    for (;;) {
      if (existsSync(path)) {
        const socket = await new Promise<Socket | undefined>((resolve) => {
          const attempt = createConnection(path);
          attempt.once("connect", () => resolve(attempt));
          attempt.once("error", () => resolve(undefined));
        });
        if (socket) return socket;
      }
      if (Date.now() > deadline) throw new ComputerError(ComputerErrorCode.timeout, "Computer Use helper did not start listening in time");
      await sleep(50);
    }
  }

  private lost(client: RpcClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    if (this.stopped) return;
    this.crashed = true;
    log.warn("computer", "helper connection lost; it will be restarted on the next call");
  }
}
