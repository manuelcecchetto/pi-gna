// Apps opened from Finder or the Dock inherit launchd's minimal environment instead of your shell's, so `pi`
// (often under nvm or Homebrew), the `node` its shebang needs, and provider API keys exported in shell profiles
// would all be missing. Like VS Code, read the environment of an interactive login shell once at startup.
import { execFile } from "node:child_process";
import { log } from "./log";

const MARK = "__PIGNA_ENV__";
/** Shell-local or per-process values that must not leak into ours. */
const SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM_SESSION_ID"]);

export async function loadShellEnv(): Promise<void> {
  const shell = process.env.SHELL || "/bin/zsh";
  const started = Date.now();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        shell,
        ["-ilc", `printf '${MARK}'; /usr/bin/env -0; printf '${MARK}'`],
        // DISABLE_AUTO_UPDATE keeps oh-my-zsh from prompting; the timeout covers profiles that never return.
        { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
      child.stdin?.end();
    });
    const body = stdout.split(MARK)[1];
    if (body === undefined) throw new Error("no environment in shell output");
    let count = 0;
    for (const entry of body.split("\0")) {
      const at = entry.indexOf("=");
      if (at <= 0 || SKIP.has(entry.slice(0, at))) continue;
      process.env[entry.slice(0, at)] = entry.slice(at + 1);
      count++;
    }
    log.info("pigna", `loaded ${count} variables from ${shell} in ${Date.now() - started} ms`);
  } catch (error) {
    log.warn("pigna", `could not read the ${shell} login environment (${(error as Error).message}); pi may not be found`);
  }
}
