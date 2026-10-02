// Read-only view of pi's own settings where pi-gna needs them for display. pi still owns behavior;
// project settings (.pi/settings.json) can override these after project trust and are not read here.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionSettings } from "../shared/compaction";

export async function readCompactionSettings(): Promise<CompactionSettings> {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { compaction?: CompactionSettings };
    return settings.compaction ?? {};
  } catch {
    return {};
  }
}
