// Which chats worked on which ATP plan: the orchestrator's session file and, per node, the workers' (a node runs again
// after a stop). Kept in userData/atp-threads.json so every client opens the same chats; the desktop's older copy
// (localStorage) is merged in once.
import { readFile, rename, writeFile } from "node:fs/promises";
import { isPlanPath } from "../shared/atp";
import type { AtpPlanThreads } from "../shared/host-api";
import { log } from "./log";

interface File {
  /** The window's localStorage copy has been merged. */
  imported?: boolean;
  plans: Record<string, AtpPlanThreads>;
}

const isPath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && value.endsWith(".jsonl");

/** Only well-formed entries: plans are `.atp.json` paths, threads are session files. */
function parsePlans(raw: unknown): Record<string, AtpPlanThreads> {
  const plans: Record<string, AtpPlanThreads> = {};
  if (!raw || typeof raw !== "object") return plans;
  for (const [plan, value] of Object.entries(raw)) {
    if (!isPlanPath(plan) || !value || typeof value !== "object") continue;
    const entry = value as { orchestrator?: unknown; workers?: unknown };
    const workers: Record<string, string[]> = {};
    if (entry.workers && typeof entry.workers === "object") {
      for (const [node, paths] of Object.entries(entry.workers)) if (Array.isArray(paths) && paths.some(isPath)) workers[node] = [...new Set(paths.filter(isPath))];
    }
    plans[plan] = { ...(isPath(entry.orchestrator) ? { orchestrator: entry.orchestrator } : {}), workers };
  }
  return plans;
}

export class AtpThreads {
  private file: File = { plans: {} };
  private readonly loaded: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly changed: (plan: string, threads: AtpPlanThreads) => void = () => undefined,
  ) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { imported?: unknown; plans?: unknown };
      this.file = { imported: raw.imported === true, plans: parsePlans(raw.plans) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("atp", `cannot read ${this.path}: ${(error as Error).message}`);
    }
  }

  async get(plan: string): Promise<AtpPlanThreads> {
    await this.loaded;
    return this.file.plans[plan] ?? { workers: {} };
  }

  /** A worker chat's session file belongs to its node. */
  async remember(plan: string, node: string, path: string): Promise<void> {
    await this.loaded;
    const entry = this.file.plans[plan] ?? { workers: {} };
    const paths = entry.workers[node] ?? [];
    if (paths.includes(path)) return;
    await this.set(plan, { ...entry, workers: { ...entry.workers, [node]: [...paths, path] } });
  }

  async setOrchestrator(plan: string, path: string): Promise<void> {
    await this.loaded;
    const entry = this.file.plans[plan] ?? { workers: {} };
    if (entry.orchestrator === path) return;
    await this.set(plan, { ...entry, orchestrator: path });
  }

  /**
   * Merge the window's earlier copy, once: what the host already knows wins, the rest is added (workers' lists in
   * their order). Anything malformed is dropped; a second call does nothing.
   */
  async importLegacy(raw: unknown): Promise<void> {
    await this.loaded;
    if (this.file.imported) return;
    this.file = { ...this.file, imported: true };
    const merged: string[] = [];
    for (const [plan, old] of Object.entries(parsePlans(raw))) {
      const have = this.file.plans[plan] ?? { workers: {} };
      const workers = { ...have.workers };
      for (const [node, paths] of Object.entries(old.workers)) workers[node] = [...new Set([...(workers[node] ?? []), ...paths])];
      this.file.plans[plan] = { ...(have.orchestrator ?? old.orchestrator ? { orchestrator: have.orchestrator ?? old.orchestrator } : {}), workers };
      merged.push(plan);
    }
    await this.save();
    for (const plan of merged) this.changed(plan, this.file.plans[plan] as AtpPlanThreads);
    if (merged.length) log.info("atp", `merged the threads of ${merged.length} plan(s) from the window`);
  }

  private async set(plan: string, threads: AtpPlanThreads): Promise<void> {
    this.file.plans[plan] = threads;
    await this.save();
    this.changed(plan, threads);
  }

  /** Writes queue up, each a temp file renamed over the last. */
  private save(): Promise<void> {
    const json = JSON.stringify(this.file, null, 2);
    this.writing = this.writing.then(async () => {
      try {
        await writeFile(`${this.path}.tmp`, json);
        await rename(`${this.path}.tmp`, this.path);
      } catch (error) {
        log.warn("atp", `cannot save ${this.path}: ${(error as Error).message}`);
      }
    });
    return this.writing;
  }
}
