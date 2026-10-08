// pi's own settings where pi-gna needs them: for display, to carry a project's trust to its cards' worktrees, and
// the keys the Settings page edits (src/shared/pi-settings.ts). pi still owns behavior; project settings
// (.pi/settings.json) can override these after project trust and are not read here.
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompactionSettings } from "../shared/compaction";
import { type PiSettingsState, patchPiSettings, readPiValues } from "../shared/pi-settings";

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const settingsFile = () => join(agentDir(), "settings.json");

/** The file as an object; {} when there is none. Throws when it is not a JSON object, which pi-gna never overwrites. */
async function readSettingsObject(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); fix it first`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object; fix it first`);
  return raw as Record<string, unknown>;
}

export async function readPiSettings(): Promise<PiSettingsState> {
  const path = settingsFile();
  try {
    return { path, values: readPiValues(await readSettingsObject(path)) };
  } catch (error) {
    return { path, values: {}, problem: (error as Error).message };
  }
}

/** pi locks its settings file with proper-lockfile: a `<file>.lock` folder, retried 10 times 20 ms apart, stale
 * after 10 s. Take the same lock, so neither of us writes over the other's change. */
async function withPiLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  for (let attempt = 1; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > 10_000) await rm(lock, { recursive: true, force: true });
      else if (attempt >= 10) throw new Error("pi is saving its settings right now; try again");
      else if (held) await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Change the Settings page's keys in pi's settings.json and leave the rest of it as it is. Rejects when the file is
 * not valid JSON or the change is not valid. Written as pi writes it (2-space JSON) through a temp file beside the
 * real file, so a symlinked settings.json stays a symlink. */
export async function writePiSettings(patch: unknown): Promise<PiSettingsState> {
  const path = settingsFile();
  await mkdir(dirname(path), { recursive: true });
  const next = await withPiLock(path, async () => {
    const next = patchPiSettings(await readSettingsObject(path), patch);
    const target = await realpath(path).catch(() => path);
    const mode = (await stat(target).catch(() => undefined))?.mode;
    const tmp = `${target}.pigna-${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), mode === undefined ? undefined : { mode: mode & 0o777 });
    await rename(tmp, target);
    return next;
  });
  return { path, values: readPiValues(next) };
}

/** The context files pi looks for in each folder from the cwd up, and in its own folder. */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

/**
 * What a starting pi reads besides its arguments: its settings, models and trust, the system prompt and context files
 * (from the cwd up), and its resource folders (a file added or removed changes the folder). Their change times and sizes
 * as one string: a pi started earlier is as current as a new one while this is unchanged (a spare pi, see SessionHost).
 */
export async function piInputs(cwd: string): Promise<string> {
  const agent = agentDir();
  const resources = ["SYSTEM.md", "APPEND_SYSTEM.md", "extensions", "skills", "prompts", "themes"];
  const paths = [
    ...["settings.json", "models.json", "trust.json", ...CONTEXT_FILES, ...resources].map((name) => join(agent, name)),
    ...["settings.json", ...resources].map((name) => join(cwd, ".pi", name)),
    join(cwd, ".agents", "skills"),
  ];
  for (let dir = cwd; ; dir = dirname(dir)) {
    paths.push(...CONTEXT_FILES.map((name) => join(dir, name)));
    if (dirname(dir) === dir) break;
  }
  const stamps = await Promise.all(paths.map((path) => stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => "-")));
  return stamps.join(",");
}

export async function readCompactionSettings(): Promise<CompactionSettings> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir(), "settings.json"), "utf8")) as { compaction?: CompactionSettings };
    return settings.compaction ?? {};
  } catch {
    return {};
  }
}

/**
 * Whether you trust the project at `cwd` with its own pi resources (.pi settings and extensions, .agents/skills), as
 * pi decides it: the decision saved in its trust.json for the nearest folder, by real path. Undefined when you have
 * not decided, or the store cannot be read (pi then asks or refuses on its own).
 */
export async function projectTrust(cwd: string): Promise<boolean | undefined> {
  let trust: Record<string, unknown>;
  try {
    trust = JSON.parse((await readFile(join(agentDir(), "trust.json"), "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  let dir = await realpath(cwd).catch(() => cwd);
  for (;;) {
    const decision = trust[dir];
    if (typeof decision === "boolean") return decision;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
