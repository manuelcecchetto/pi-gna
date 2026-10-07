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
  const relative = SHIM_SCRIPT.exec(text)?.[1];
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
