// A restart's handover of running chats (SessionHost.handOff, then restore in the next pi-gna): the chats and the
// bridge port go to a file in the profile, the pis keep their FIFO folders, and the next launch takes both over. A
// FIFO folder nobody takes over (a crash, a handover the next version cannot read) has its pi stopped at launch.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";
import { isPi } from "./pi-process";
import type { HandedOffChat } from "./session-host";

/** Bump when a handover written by this version would not fit the next one (the shape of `SessionState`, `PiIo`). */
export const HANDOFF_VERSION = 1;

export interface Handoff {
  version: number;
  /** When pi-gna wrote it. */
  at: number;
  bridgePort: number;
  chats: HandedOffChat[];
}

/** Written at quit; it holds bridge tokens, so only the user reads it. */
export function writeHandoff(path: string, chats: HandedOffChat[], bridgePort: number): void {
  const handoff: Handoff = { version: HANDOFF_VERSION, at: Date.now(), bridgePort, chats };
  writeFileSync(`${path}.tmp`, JSON.stringify(handoff), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  log.info("pigna", `handed ${chats.length} chat(s) over to the next pi-gna`);
}

/** Read at launch, once: the file goes either way, so a handover is never taken twice. */
export function takeHandoff(path: string): Handoff | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const handoff = JSON.parse(readFileSync(path, "utf8")) as Handoff;
    if (handoff.version === HANDOFF_VERSION && Array.isArray(handoff.chats)) return handoff;
    log.warn("pigna", `a handover of version ${handoff.version} is not this pi-gna's (${HANDOFF_VERSION}): its chats stop`);
  } catch (error) {
    log.warn("pigna", `could not read the handover: ${(error as Error).message}`);
  } finally {
    rmSync(path, { force: true });
  }
  return undefined;
}

/** Stop the pis in FIFO folders that are not handed over (`keep`), and remove those folders. */
export function sweepPiIo(root: string, keep: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    if (keep.has(dir)) continue;
    const pid = Number(readText(join(dir, "pid")).trim());
    if (pid && isPi(pid)) {
      log.info("pigna", `stopping pi ${pid}, left from an earlier pi-gna`);
      process.kill(pid, "SIGTERM");
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
