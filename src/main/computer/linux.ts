// The Linux Computer Use helper (native/computer-use-linux, Python on the system's PyGObject, libei and AT-SPI) for
// KDE Plasma on Wayland. Installed under ~/.pi-gna/computer-use/linux with its own copy of the system interpreter:
// KWin lets only executables that a desktop file names (X-KDE-DBUS-Restricted-Interfaces) take window screenshots, so
// the desktop file names that copy and no other Python program gains the right.
import { execFile, spawn } from "node:child_process";
import { copyFile, cp, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HELPER_BUNDLE_ID } from "../../shared/computer";
import { log } from "../log";
import { CALL_TIMEOUT_MS } from "./rpc";
import type { ComputerServiceDeps } from "./service";

const run = promisify(execFile);
export const LINUX_HELPER = "linux";
const INTERPRETER = "pigna-computer-use";
const SCRIPT = join("pigna_cu", "__main__.py");

/** What a test replaces: the home folder (install dir, desktop file), the system interpreter and KDE's cache refresh. */
export interface LinuxEnv {
  home: string;
  python(): Promise<string>;
  refresh(): Promise<unknown>;
}

/** HELPER_VERSION of a helper folder, undefined when missing. An install whose interpreter copy no longer matches the
 * system's (a Python upgrade) counts as missing, so it is installed again. */
async function readVersion(dir: string, system: () => Promise<string>): Promise<number | undefined> {
  const source = await readFile(join(dir, SCRIPT), "utf8").catch(() => undefined);
  const version = source && /^HELPER_VERSION = (\d+)/m.exec(source)?.[1];
  if (!version) return undefined;
  const copy = join(dir, INTERPRETER);
  if (await stat(copy).catch(() => undefined)) {
    const [mine, theirs] = await Promise.all([stat(copy), system().then((path) => stat(path))]).catch(() => [undefined, undefined]);
    if (!mine || !theirs || mine.size !== theirs.size) return undefined;
  }
  return Number(version);
}

/** The system Python the helper's packages belong to (python-gobject, python-dbus, python-pillow). */
async function systemPython(): Promise<string> {
  const { stdout } = await run("python3", ["-I", "-c", "import sys; print(sys.executable)"]);
  return realpath(stdout.trim());
}

const realEnv = (): LinuxEnv => ({ home: homedir(), python: systemPython, refresh: () => run("kbuildsycoca6", []) });

/** The desktop file that authorizes the helper's interpreter copy for KWin's ScreenShot2. */
export const desktopFile = (home: string): string => join(home, ".local", "share", "applications", `${HELPER_BUNDLE_ID}.desktop`);

export const linuxDeps = (bundledDir: string, socketDir: string, env: LinuxEnv = realEnv()): ComputerServiceDeps => ({
  bundledApp: bundledDir,
  installDir: join(env.home, ".pi-gna", "computer-use"),
  appName: LINUX_HELPER,
  socketDir,
  parentPid: process.pid,
  launch: async (dir, args) => {
    const logFile = await open(join(dir, "helper.log"), "a");
    const child = spawn(join(dir, INTERPRETER), ["-I", join(dir, SCRIPT), ...args], {
      detached: true,
      stdio: ["ignore", logFile.fd, logFile.fd],
      env: { ...process.env, PYTHONHOME: "/usr" },
    });
    child.unref();
    await logFile.close();
  },
  readVersion: (dir) => readVersion(dir, env.python),
  install: async (from, to) => {
    await rm(to, { recursive: true, force: true });
    await mkdir(to, { recursive: true });
    await cp(join(from, "pigna_cu"), join(to, "pigna_cu"), { recursive: true });
    await copyFile(await env.python(), join(to, INTERPRETER));
    const file = desktopFile(env.home);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      file,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=pi-gna Computer Use",
        "Comment=Lets pi-gna's Computer Use helper take window screenshots",
        `Exec=${join(to, INTERPRETER)}`,
        "NoDisplay=true",
        "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2",
        "",
      ].join("\n"),
    );
    // KWin looks executables up through KDE's service cache.
    await env.refresh().catch((error) => log.warn("computer", `kbuildsycoca6: ${error instanceof Error ? error.message : error}`));
  },
  readRequirement: async () => undefined,
  resetGrants: async () => undefined,
  connectTimeoutMs: 8000,
  callTimeoutMs: CALL_TIMEOUT_MS,
});
