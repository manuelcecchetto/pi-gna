// Runs the Tailscale CLI. Reading status is always safe; the only tailnet change pi-gna makes is `tailscale serve`
// (and turning that mapping off), and only when the user clicked (src/main/remote.ts). Parsing and the exact
// arguments are in src/shared/tailscale.ts.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { findCli, noTailscale, parseServe, parseStatus, type TailscaleStatus } from "../shared/tailscale";

/** What RemoteHost needs from Tailscale; tests replace it. */
export interface Tailscale {
  status(): Promise<TailscaleStatus>;
  /** Runs a command that changes the tailnet (serve/unserve arguments). Rejects with the CLI's message. */
  run(args: string[]): Promise<void>;
}

const TIMEOUT_MS = 15_000;

function exec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // The Tailscale.app binary picks GUI or CLI mode from the environment (SHLVL, TERM...). Launched from the Dock,
    // pi-gna has none of those, so the binary tries to start the GUI, prints "The Tailscale GUI failed to start" and
    // exits 0. TAILSCALE_BE_CLI is Tailscale's own switch for CLI mode; the `tailscale` on PATH ignores it.
    const env = { ...process.env, TAILSCALE_BE_CLI: "1" };
    execFile(file, args, { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).toString().trim().split("\n")[0] || error.message));
      else resolve(stdout.toString());
    });
  });
}

/** Runs a `--json` command; output that is not JSON is reported as what the CLI printed, not as a parse error. */
async function execJson(file: string, args: string[]): Promise<string> {
  const stdout = await exec(file, args);
  try {
    JSON.parse(stdout || "{}");
  } catch {
    throw new Error(stdout.trim().split("\n")[0] || "Tailscale printed no status.");
  }
  return stdout;
}

export class TailscaleCli implements Tailscale {
  /** The CLI is looked up on every call: the login shell's PATH arrives after launch, and Tailscale may be installed meanwhile. */
  private cli = () => findCli(process.env.PATH, existsSync);

  async status(): Promise<TailscaleStatus> {
    const cli = this.cli();
    if (!cli) return noTailscale();
    try {
      const status = { installed: true, funnel: false, ...parseStatus(await execJson(cli, ["status", "--json"])) };
      // Serving needs a signed-in node; a signed-out CLI answers with an error.
      if (!status.loggedIn) return status;
      return { ...status, ...parseServe(await execJson(cli, ["serve", "status", "--json"]).catch(() => "{}")) };
    } catch (error) {
      return { installed: true, loggedIn: false, httpsAvailable: false, funnel: false, error: (error as Error).message };
    }
  }

  async run(args: string[]): Promise<void> {
    const cli = this.cli();
    if (!cli) throw new Error("Tailscale is not installed.");
    await exec(cli, args);
  }
}
