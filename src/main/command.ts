// Where a command name points, and how to start it. On Windows, npm installs commands (pi, npm itself) as .cmd shims,
// which Node's spawn refuses without a shell (CVE-2024-27980); a shell would also reparse user paths and prompts. So
// a shim is resolved to the script it runs and started with node. Elsewhere a command spawns as is.
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Command {
  file: string;
  args: string[];
}

/** The script line of an npm (cmd-shim) or pnpm shim: `"%dp0%\node_modules\...\cli.js"` or `"%~dp0\..."`. */
const SHIM_SCRIPT = /"%~?dp0%?\\([^"%]+\.[cm]?js)"/i;
/** Node's bundled npm.cmd/npx.cmd set the CLI in a variable, next to npm-prefix.js (a helper, not the entry point). */
const NPM_CLI_SCRIPT = /^\s*SET\s+"(?:NPM|NPX)_CLI_JS=%~dp0\\([^"%]+\.[cm]?js)"\s*$/im;

/** Windows has no executable bit: any file found by its extension runs. */
function executable(file: string, win: boolean): boolean {
  try {
    accessSync(file, win ? constants.F_OK : constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The file `name` runs: a path as given, or the first match on `path` (with PATHEXT on Windows). */
export function which(name: string, path = process.env.PATH ?? "", platform = process.platform, pathext = process.env.PATHEXT): string | undefined {
  const win = platform === "win32";
  if (name.includes("/") || (win && name.includes("\\"))) return resolve(name);
  // Windows looks a bare name up by its extensions only: npm puts a `pi` shell script next to pi.cmd.
  const extensions = win && !/\.[^.\\/]+$/.test(name) ? (pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of path.split(win ? ";" : ":").filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(dir, name + extension.toLowerCase());
      if (executable(file, win)) return file;
    }
  }
  return undefined;
}

/** The script a Windows .cmd shim runs, if it is one pi-gna can read. */
export function shimScript(file: string): string | undefined {
  if (!/\.(cmd|bat)$/i.test(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const relative = NPM_CLI_SCRIPT.exec(text)?.[1] ?? SHIM_SCRIPT.exec(text)?.[1];
  if (!relative) return undefined;
  const script = join(dirname(file), ...relative.split(/[\\/]/).filter(Boolean));
  return existsSync(script) ? script : undefined;
}

/** How to spawn `name` with `args` without a shell. */
export function resolveCommand(name: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): Command {
  if (platform !== "win32") return { file: name, args };
  const path = env.PATH ?? env.Path ?? "";
  const file = which(name, path, platform, env.PATHEXT);
  if (!file) return { file: name, args };
  const script = shimScript(file);
  if (!script) return { file, args };
  // The shim's own rule: the node.exe next to it, else the one on the PATH.
  const local = join(dirname(file), "node.exe");
  const node = existsSync(local) ? local : (which("node", path, platform, env.PATHEXT) ?? "node");
  return { file: node, args: [script, ...args] };
}

/** Git for Windows' build folders, newest layout first: 2.56 moved x64 from mingw64 to ucrt64. */
const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"];

/**
 * The real git.exe behind Git for Windows' `cmd\git.exe` launcher (the portable build's launcher is `bin\git.exe`),
 * when it exists. The installer puts only the launcher on PATH; it sets MSYSTEM, HOME and PATH, then starts the
 * real binary as a second process, so every git command costs two process starts. It also leaks about one kernel
 * token per run that Windows frees only at reboot: an app shelling out to git all day reaches millions in a week
 * or two, and process creation slows down machine-wide. Git for Windows supports running the real binary directly
 * (gitforwindows.org/git-wrapper). Anything that is not that launcher shape, Scoop and Chocolatey shims included,
 * comes back undefined.
 */
export function realGitForWindows(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const name = parts.at(-1)?.toLowerCase();
  const parent = parts.at(-2)?.toLowerCase();
  if (name !== "git.exe" || (parent !== "cmd" && parent !== "bin")) return undefined;
  const root = dirname(dirname(file));
  return GIT_FOR_WINDOWS_BUILDS.map((build) => join(root, build, "bin", "git.exe")).find((candidate) => existsSync(candidate));
}

/** How long a found git's resolution is remembered (resolveGit). */
const GIT_RESOLUTION_MS = 30_000;
let gitCached: { key: string; file: string; at: number } | undefined;

/** How to run git with `args` without a shell: on Windows, Git for Windows' real binary when there is one. */
export function resolveGit(args: string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): Command {
  if (platform !== "win32") return { file: "git", args };
  const path = env.PATH ?? env.Path ?? "";
  // The PATH walk stats every entry times every PATHEXT extension, synchronously, and git runs often enough that
  // the answer is worth remembering for a while. A miss is never remembered, so git appearing just works; what the
  // memory costs is a Git upgrade that moves the real binary failing commands for up to those 30 seconds.
  const key = `${path}\n${env.PATHEXT ?? ""}\n${env.MSYSTEM ? "msystem" : ""}`;
  if (gitCached?.key === key && Date.now() - gitCached.at < GIT_RESOLUTION_MS) return { file: gitCached.file, args };
  const found = which("git", path, platform, env.PATHEXT);
  if (!found) return { file: "git", args };
  // A .cmd/.bat wrapper cannot be started without a shell (CVE-2024-27980), and a shell would cut a multi-line
  // commit message at its first newline, so Node's own lookup keeps that case. With MSYSTEM set (say a Git Bash
  // shell) the real binary does not add Git's folders to PATH itself and a `#!/bin/sh` hook would not start, so
  // the launcher stays there too.
  const file = /\.(cmd|bat)$/i.test(found) ? "git" : env.MSYSTEM ? found : (realGitForWindows(found) ?? found);
  gitCached = { key, file, at: Date.now() };
  return { file, args };
}
