import { which } from "./command";

/** The ATP librarian is Python 3. Windows installations commonly provide py/python, not python3. Resolve without
 * a shell and use the same invocation in worker prompts. No downloads, elevation or global PATH changes. */
export function pythonForHost(platform = process.platform, path = process.env.PATH ?? process.env.Path ?? ""): { file: string; args: string[]; command: string } {
  if (platform !== "win32") return { file: "python3", args: [], command: "python3" };
  for (const name of ["py", "python", "python3"]) {
    const file = which(name, path, platform);
    // Avoid the unconfigured Microsoft Store app-execution aliases (which can open the Store instead of Python).
    if (!file || /[\\/]Microsoft[\\/]WindowsApps[\\/](?:py|python3?)\.exe$/i.test(file)) continue;
    return { file, args: name === "py" ? ["-3"] : [], command: name === "py" ? "py -3" : name };
  }
  throw new Error("Python 3 is not installed (or not on PATH). Install Python 3 with py.exe or python.exe, then restart pi-gna.");
}
