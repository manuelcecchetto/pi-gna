// Read-only view of pi's own settings where pi-gna needs them: for display, and to carry a project's trust to its
// cards' worktrees. pi still owns behavior; project settings (.pi/settings.json) can override these after project
// trust and are not read here.
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompactionSettings } from "../shared/compaction";

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

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
