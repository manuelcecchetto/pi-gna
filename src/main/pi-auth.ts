// pi's provider logins (/login) for the Settings page's Providers section. pi's RPC mode cannot log in, so this runs
// resources/pi-auth.mts with pi's own SDK, found next to `pi` on the PATH (or PIGNA_PI_BIN), and with the `node` on the
// PATH, the one pi's shebang runs. The helper starts on first use and stops after a minute with nothing to do. One
// login at a time: a new one cancels the last. Nothing that passes through is logged; answers can be API keys.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AuthMethod, AuthReply, AuthRequest, AuthState, LoginResult, LoginUpdate } from "../shared/auth";
import { JsonlSplitter } from "./jsonl";
import { log } from "./log";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const STDERR_TAIL = 2000;

/** The folder of the pi package whose `pi` is `bin` (a path, or a name looked up on `path`). */
export function findPiSdk(bin: string, path = process.env.PATH ?? ""): string | undefined {
  const file = bin.includes("/") ? resolve(bin) : path.split(":").filter(Boolean).map((dir) => join(dir, bin)).find(executable);
  if (!file) return undefined;
  let dir: string;
  try {
    dir = dirname(realpathSync(file));
  } catch {
    return undefined;
  }
  for (;;) {
    if (packageName(join(dir, "package.json")) === SDK_PACKAGE) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function packageName(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name;
  } catch {
    return undefined;
  }
}

export interface PiAuthOptions {
  /** resources/pi-auth.mts */
  script: string;
  /** The folder of pi's package; looked up for each helper start. */
  sdk?: () => string | undefined;
  node?: string;
  idleMs?: number;
}

type Failure = Error & { cancelled?: boolean };

interface Helper {
  child: ChildProcessWithoutNullStreams;
  stderr: string;
  fatal?: string;
}

export class PiAuth {
  private helper?: Helper;
  private readonly pending = new Map<string, (reply: { ok: true; value?: unknown } | { ok: false; error: string; cancelled?: boolean }) => void>();
  private readonly listeners = new Map<string, (update: LoginUpdate) => void>();
  private login?: string;
  private seq = 0;
  private idle?: NodeJS.Timeout;

  constructor(private readonly options: PiAuthOptions) {}

  /** pi's providers and how each is signed in; `error` instead when pi's logins cannot be reached. */
  async list(): Promise<AuthState> {
    try {
      return (await this.request({ id: this.id(), op: "list" })) as AuthState;
    } catch (error) {
      return { providers: [], error: (error as Error).message };
    }
  }

  /** Runs one login to its end; its prompts and events go to `onUpdate`, the answers come back through answer(). */
  async signIn(provider: string, method: AuthMethod, onUpdate: (update: LoginUpdate) => void): Promise<LoginResult> {
    this.cancel();
    const id = this.id();
    this.login = id;
    this.listeners.set(id, onUpdate);
    try {
      await this.request({ id, op: "login", provider, method });
      return { ok: true };
    } catch (error) {
      return { ok: false, cancelled: (error as Failure).cancelled === true, error: (error as Error).message };
    } finally {
      this.listeners.delete(id);
      if (this.login === id) this.login = undefined;
    }
  }

  answer(n: number, value: string): void {
    if (this.login) this.write({ id: this.login, op: "answer", n, value });
  }

  cancel(): void {
    if (this.login) this.write({ id: this.login, op: "cancel" });
  }

  /** Removes the credential pi saved in auth.json. */
  async signOut(provider: string): Promise<void> {
    await this.request({ id: this.id(), op: "logout", provider });
  }

  /** At quit: cancels a login and stops the helper. */
  close(): void {
    this.cancel();
    this.stop();
  }

  private id(): string {
    return `a${++this.seq}`;
  }

  private request(request: AuthRequest): Promise<unknown> {
    let helper: Helper;
    try {
      helper = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, (reply) => (reply.ok ? resolve(reply.value) : reject(Object.assign(new Error(reply.error), { cancelled: reply.cancelled }))));
      this.write(request, helper);
    });
  }

  private write(request: AuthRequest, helper = this.helper): void {
    if (helper?.child.stdin.writable) helper.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  private start(): Helper {
    if (this.helper) return this.helper;
    const sdk = (this.options.sdk ?? (() => findPiSdk(process.env.PIGNA_PI_BIN || "pi")))();
    if (!sdk) throw new Error(`pi-gna could not find pi's SDK next to \`${process.env.PIGNA_PI_BIN || "pi"}\`. Install pi with \`npm install -g ${SDK_PACKAGE}\`.`);
    const child = spawn(this.options.node ?? "node", [this.options.script, sdk], { cwd: homedir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const helper: Helper = { child, stderr: "" };
    this.helper = helper;
    log.info("auth", `started pi's login helper (pid ${child.pid ?? "?"}) with ${sdk}`);
    const stdout = new JsonlSplitter();
    child.stdout.on("data", (chunk: Buffer) => this.onLines(helper, stdout.push(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      helper.stderr = (helper.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) =>
      this.exited(helper, error.code === "ENOENT" ? "`node` is not on your PATH, so pi-gna cannot run pi's login." : `pi's login helper failed: ${error.message}`),
    );
    child.on("exit", (code, signal) => {
      const tail = helper.stderr.trim().split("\n").at(-1);
      this.exited(helper, `pi's login helper stopped (${signal ?? `exit code ${code}`})${tail ? `: ${tail}` : ""}`);
    });
    return helper;
  }

  private onLines(helper: Helper, lines: string[]): void {
    for (const line of lines) {
      let reply: AuthReply;
      try {
        reply = JSON.parse(line) as AuthReply;
      } catch {
        continue;
      }
      if ("fatal" in reply) helper.fatal = reply.fatal;
      else if ("update" in reply) this.listeners.get(reply.id)?.(reply.update);
      else {
        const settle = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        settle?.(reply);
      }
    }
    this.idleLater();
  }

  private exited(helper: Helper, reason: string): void {
    if (this.helper !== helper) return;
    this.helper = undefined;
    clearTimeout(this.idle);
    if (helper.fatal) log.warn("auth", helper.fatal);
    for (const settle of this.pending.values()) settle({ ok: false, error: helper.fatal ?? reason });
    this.pending.clear();
  }

  private idleLater(): void {
    clearTimeout(this.idle);
    if (this.helper && this.pending.size === 0) this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 60_000);
  }

  private stop(): void {
    const helper = this.helper;
    if (!helper) return;
    this.helper = undefined;
    clearTimeout(this.idle);
    for (const settle of this.pending.values()) settle({ ok: false, error: "pi's login helper stopped" });
    this.pending.clear();
    // A closed stdin ends the helper; it exits by itself within two seconds.
    helper.child.stdin.end();
    setTimeout(() => helper.child.exitCode === null && helper.child.kill(), 5000).unref();
  }
}
