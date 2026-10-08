// Apps opened from Finder or the Dock inherit launchd's minimal environment instead of your shell's, so `pi`
// (often under nvm or Homebrew), the `node` its shebang needs, and provider API keys exported in shell profiles
// would all be missing. Like VS Code, read the environment of an interactive login shell once at startup.
//
// That takes 1–2 s. Handlers that only read pi's files (the session list, pi's settings) need just the variables
// that move pi's folders, so those are kept from the last good read and applied at once (`piDirs`). The rest of
// the environment, API keys included, is never written to disk.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { log } from "./log";

const MARK = "__PIGNA_ENV__";
/** Shell-local or per-process values that must not leak into ours. */
const SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM_SESSION_ID"]);
/** Where pi keeps its sessions and settings (session-index.ts, pi-settings.ts). */
const PI_DIRS = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"] as const;
type PiDirs = Partial<Record<(typeof PI_DIRS)[number], string>>;

export interface ShellEnv {
  /** The whole login environment is in process.env: wait for it before spawning pi, rg, git, gh or node. */
  env: Promise<void>;
  /** pi's folders are known: enough for reading pi's files. */
  piDirs: Promise<void>;
}

export const LAUNCH_ENV: ShellEnv = { env: Promise.resolve(), piDirs: Promise.resolve() };

/** `cacheFile` keeps the shell's pi folders between launches. */
export function loadShellEnv(cacheFile: string, shell = process.env.SHELL || "/bin/zsh"): ShellEnv {
  // Windows apps get the user's full environment from Explorer; there is no login shell to ask.
  if (process.platform === "win32") return LAUNCH_ENV;
  // Started before the cached folders are applied, so the shell reports its own values, not ours.
  const read = readShellEnv(shell);
  const cached = readCache(cacheFile).then((dirs) => {
    if (dirs) for (const key of PI_DIRS) if (dirs[key] !== undefined) process.env[key] = dirs[key];
    return dirs;
  });
  const env = Promise.all([read, cached]).then(async ([vars, before]) => {
    if (!vars) return;
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    // The shell has the last word, also when it no longer sets a folder the cache applied.
    const dirs: PiDirs = {};
    for (const key of PI_DIRS) {
      if (vars[key] === undefined) delete process.env[key];
      else dirs[key] = vars[key];
    }
    if (before && JSON.stringify(before) !== JSON.stringify(dirs)) log.info("pigna", "pi's folders changed in the login shell since the last launch");
    await writeFile(cacheFile, JSON.stringify(dirs)).catch((error) => log.warn("pigna", `could not save pi's folders: ${(error as Error).message}`));
  });
  // The first launch has no cache: the folders are known only once the shell answers.
  return { env, piDirs: cached.then((dirs) => (dirs ? undefined : env)) };
}

async function readCache(file: string): Promise<PiDirs | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const dirs: PiDirs = {};
    for (const key of PI_DIRS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && value) dirs[key] = value;
    }
    return dirs;
  } catch {
    return undefined;
  }
}

async function readShellEnv(shell: string): Promise<Record<string, string> | undefined> {
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
    const vars: Record<string, string> = {};
    for (const entry of body.split("\0")) {
      const at = entry.indexOf("=");
      if (at <= 0 || SKIP.has(entry.slice(0, at))) continue;
      vars[entry.slice(0, at)] = entry.slice(at + 1);
    }
    log.info("pigna", `loaded ${Object.keys(vars).length} variables from ${shell} in ${Date.now() - started} ms`);
    return vars;
  } catch (error) {
    log.warn("pigna", `could not read the ${shell} login environment (${(error as Error).message}); pi may not be found`);
    return undefined;
  }
}
