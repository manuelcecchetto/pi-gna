// The Setup flow's checks and pi's install (src/shared/setup.ts). Everything runs with the login shell's PATH, like
// pi's chats, so what Setup finds is what chats run. One install at a time; npm's output streams to the window.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { installError, nodeSupported, PI_INSTALL_ARGS, piReady, type SetupInstallResult, type SetupStatus } from "../shared/setup";
import { resolveCommand } from "./command";
import { log } from "./log";
import { findPiSdk } from "./pi-auth";

const OUTPUT_TAIL = 8000;
/** A line longer than this without a newline is passed on in pieces. */
const MAX_LINE = 64 * 1024;

const piBin = () => process.env.PIGNA_PI_BIN || "pi";

type Ran = { ok: true; out: string } | { ok: false; missing: boolean; error: string };

/** A command's trimmed stdout; `missing` when there is no such command. A failure keeps the end of stderr: "Command
 * failed" alone does not say what to fix. */
function run(command: string, args: string[], timeout: number): Promise<Ran> {
  return new Promise((resolve) => {
    const resolved = resolveCommand(command, args);
    execFile(resolved.file, resolved.args, { timeout, env: process.env }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, out: stdout.trim() });
      const code = (error as NodeJS.ErrnoException).code;
      const said = stderr.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-6);
      resolve({
        ok: false,
        missing: code === "ENOENT",
        error: error.killed ? `no answer in ${Math.round(timeout / 1000)} s` : [error.message.split("\n")[0] ?? "failed", ...said].join("\n"),
      });
    });
  });
}

export interface PiSetupOptions {
  /** One line of npm's output, as it prints it. */
  onLine(line: string): void;
  /** Per check (`node --version`, `pi --version`, …). */
  checkMs?: number;
  /** The whole install; npm is killed after it. */
  installMs?: number;
}

export class PiSetup {
  private installing?: Promise<SetupInstallResult>;
  private child?: ReturnType<typeof spawn>;

  constructor(private readonly options: PiSetupOptions) {}

  async status(): Promise<SetupStatus> {
    const bin = piBin();
    const ms = this.options.checkMs ?? 15_000;
    const [node, npm, pi] = await Promise.all([run("node", ["--version"], ms), run("npm", ["--version"], ms), run(bin, ["--version"], ms)]);
    return {
      node: node.ok ? { version: node.out.replace(/^v/, ""), ok: nodeSupported(node.out) } : null,
      npm: npm.ok,
      // A pi that is there but does not answer is broken, not missing: installing over it would not help.
      pi: pi.ok ? { version: pi.out.split("\n")[0] || "?" } : pi.missing ? null : { error: pi.error },
      sdk: findPiSdk(bin) !== undefined,
      brew: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].some(existsSync),
    };
  }

  /** `npm install -g` pi, unless pi is already there; a second call while one runs joins it. */
  installPi(): Promise<SetupInstallResult> {
    this.installing ??= this.install().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }

  /** Stops a running install (pi-gna quits). */
  dispose(): void {
    this.child?.kill();
  }

  private async install(): Promise<SetupInstallResult> {
    const before = await this.status();
    if (before.pi !== null)
      return piReady(before) ? { ok: true } : { ok: false, error: "pi is already installed. Setup does not reinstall it; fix or remove it in a terminal." };
    log.info("setup", `npm ${PI_INSTALL_ARGS.join(" ")}`);
    const result = await new Promise<SetupInstallResult>((resolve) => {
      let tail = "";
      let settled = false;
      const settle = (value: SetupInstallResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = undefined;
        resolve(value);
      };
      const npm = resolveCommand("npm", [...PI_INSTALL_ARGS]);
      const child = spawn(npm.file, npm.args, {
        env: { ...process.env, npm_config_color: "false", npm_config_progress: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      const installMs = this.options.installMs ?? 10 * 60_000;
      const timer = setTimeout(() => {
        child.kill();
        settle({
          ok: false,
          error: `npm did not finish in ${Math.round(installMs / 60_000)} minutes, so pi-gna stopped it. Check your connection and try again.`,
        });
      }, installMs);
      // stdout and stderr each keep their own unfinished line and their own decoder (a character can span chunks).
      const flushers = [child.stdout, child.stderr].map((stream) => {
        const decoder = new StringDecoder("utf8");
        let partial = "";
        const push = (text: string) => {
          tail = (tail + text).slice(-OUTPUT_TAIL);
          const lines = (partial + text).split(/\r?\n/);
          partial = lines.pop() ?? "";
          if (partial.length > MAX_LINE) {
            lines.push(partial);
            partial = "";
          }
          for (const line of lines) if (line.trim()) this.options.onLine(line);
        };
        stream.on("data", (chunk: Buffer) => push(decoder.write(chunk)));
        return () => {
          push(decoder.end());
          if (partial.trim()) this.options.onLine(partial);
          partial = "";
        };
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        settle({ ok: false, error: error.code === "ENOENT" ? "`npm` is not on your PATH. Install Node.js first." : error.message }),
      );
      child.on("close", (code) => {
        for (const flush of flushers) flush();
        log.info("setup", `npm exited with ${code}`);
        settle(code === 0 ? { ok: true } : { ok: false, error: installError(tail, code) });
      });
    });
    if (result.ok) await this.addGlobalBin();
    return result;
  }

  /** npm's global bin may be off this process's PATH (a custom prefix): append it, so chats find the new pi. */
  private async addGlobalBin(): Promise<void> {
    const prefix = await run("npm", ["prefix", "-g"], this.options.checkMs ?? 15_000);
    if (!prefix.ok || !prefix.out) return;
    const bin = join(prefix.out, "bin");
    const path = process.env.PATH ?? "";
    if (!path.split(":").includes(bin)) process.env.PATH = path ? `${path}:${bin}` : bin;
  }
}
