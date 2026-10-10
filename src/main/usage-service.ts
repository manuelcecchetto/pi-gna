// Settings > Usage on the host: one index and the price table, scanned on the first report of a launch and again on
// usage.refresh. The index reads and caches the files; this decides when that runs and what a client is told.
import { stat } from "node:fs/promises";
import { HostError } from "../shared/host-api";
import { type PriceTable, type SourceRoot, USAGE_RANGES, type UsageProgress, type UsageQuery, type UsageRange, type UsageReport, type UsageSource } from "../shared/usage";
import { buildReport } from "../shared/usage-report";
import { log } from "./log";
import { type Extractor, UsageIndex } from "./usage-index";
import { loadPriceTable } from "./usage-pricing";

const DAY_MS = 86_400_000;
/** A custom range is cut into days, so it is bounded; eleven years covers the sessions on disk. */
const MAX_CUSTOM_DAYS = 4000;
const PROGRESS_INTERVAL_MS = 250;
/** A settled run's file is read once no other settle has come for this long, so a burst of runs is read once. */
const CHANGE_SETTLE_MS = 1000;
/** `usage.changed` goes out at most this often; the last change is always announced, late if need be. */
const CHANGED_INTERVAL_MS = 10_000;
const MAX_TEXT = 1024;

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

export interface UsageServiceOptions {
  roots: () => Record<SourceRoot, string>;
  /** pi's folders can come from the login shell: the first scan waits for them. */
  piDirs: Promise<void>;
  file: string;
  openExtractor: () => Extractor;
  concurrency: number;
  publish: (progress: UsageProgress) => void;
  changed: () => void;
  prices?: () => PriceTable;
  now?: () => number;
  settleMs?: number;
  changedIntervalMs?: number;
}

export class UsageService {
  private readonly index: UsageIndex;
  private indexed: Promise<void> | undefined;
  private scanning: Promise<void> | undefined;
  private lastPublished = 0;
  private warm = false;
  private readonly changedFiles = new Set<string>();
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAnnounced = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: UsageServiceOptions) {
    this.index = new UsageIndex({ roots: options.roots, file: options.file, openExtractor: options.openExtractor, concurrency: options.concurrency });
  }

  /** The report for a query, from the facts in memory. The first report of a launch waits for the index. */
  async get(query: UsageQuery): Promise<UsageReport> {
    await this.ready();
    const prices = (this.options.prices ?? loadPriceTable)();
    const report = buildReport(this.index.allFacts(), query, prices, (this.options.now ?? Date.now)(), this.index.discovered());
    const sessions = await Promise.all(report.sessions.map(async (row) => ({ ...row, openable: row.openable && (await exists(row.path)) })));
    return { ...report, sessions };
  }

  /** Reads the files that changed since the last scan; the others come from the cache. */
  refresh(): Promise<void> {
    return this.scan();
  }

  /**
   * A settled run wrote its session file. Nothing runs until a scan has been asked for: the first scan reads every file then.
   * After that, the file is read once the settles of its burst have stopped, and the clients are told (`usage.changed`).
   */
  sessionChanged(path: string): void {
    if (!this.warm && !this.scanning) return;
    this.changedFiles.add(path);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.applyChanges().catch((error: Error) => log.warn("usage", `refresh failed: ${error.message}`));
    }, this.options.settleMs ?? CHANGE_SETTLE_MS);
  }

  private ready(): Promise<void> {
    this.indexed ??= this.scan().catch((error: unknown) => {
      this.indexed = undefined;
      throw error;
    });
    return this.indexed;
  }

  /** One scan at a time: a refresh asked while one runs joins it. */
  private scan(): Promise<void> {
    this.scanning ??= this.run().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async run(): Promise<void> {
    this.publish({ phase: "scan", done: 0, total: 0 }, true);
    try {
      await this.options.piDirs;
      await this.index.ensureIndexed((progress) =>
        this.publish({ phase: "index", done: progress.done, total: progress.total, bytes: progress.bytes, totalBytes: progress.totalBytes }),
      );
      this.warm = true;
    } finally {
      const total = this.index.discovered();
      this.publish({ phase: "done", done: total, total }, true);
    }
  }

  private publish(progress: UsageProgress, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPublished < PROGRESS_INTERVAL_MS) return;
    this.lastPublished = now;
    this.options.publish(progress);
  }

  private async applyChanges(): Promise<void> {
    this.settleTimer = undefined;
    const paths = [...this.changedFiles];
    this.changedFiles.clear();
    for (const path of paths) await this.index.refreshFile(path);
    this.announceChange();
  }

  private announceChange(): void {
    if (this.announceTimer) return;
    const wait = this.lastAnnounced + (this.options.changedIntervalMs ?? CHANGED_INTERVAL_MS) - Date.now();
    if (wait <= 0) {
      this.emitChanged();
      return;
    }
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      this.emitChanged();
    }, wait);
  }

  private emitChanged(): void {
    this.lastAnnounced = Date.now();
    this.options.changed();
  }
}

/** A client's usage query, checked before it reaches the report; an omitted query is the default one. */
export function parseUsageQuery(raw: unknown): UsageQuery {
  if (raw === undefined) return { range: "30d", source: "pigna" };
  if (typeof raw !== "object" || raw === null) throw new HostError("bad_request", "usage query must be an object");
  const { range, source, project, timeZone } = raw as Record<string, unknown>;
  return {
    range: parseRange(range),
    source: parseSource(source),
    ...(project === undefined ? {} : { project: parseProject(project) }),
    ...(timeZone === undefined ? {} : { timeZone: parseTimeZone(timeZone) }),
  };
}

const isPreset = (value: unknown): value is UsageRange => typeof value === "string" && (USAGE_RANGES as readonly string[]).includes(value);

function parseRange(value: unknown): UsageRange | { from: number; to: number } {
  if (isPreset(value)) return value;
  if (typeof value === "object" && value !== null) {
    const { from, to } = value as Record<string, unknown>;
    if (typeof from === "number" && typeof to === "number" && from < to && to - from <= MAX_CUSTOM_DAYS * DAY_MS) return { from, to };
  }
  throw new HostError("bad_request", `range must be ${USAGE_RANGES.join(", ")}, or { from, to } in epoch ms at most ${MAX_CUSTOM_DAYS} days apart`);
}

function parseSource(value: unknown): UsageSource {
  if (value === "pigna" || value === "all") return value;
  throw new HostError("bad_request", "source must be pigna or all");
}

function parseProject(value: unknown): string {
  if (typeof value === "string" && value.length <= MAX_TEXT) return value;
  throw new HostError("bad_request", `project must be a folder key of at most ${MAX_TEXT} characters`);
}

function parseTimeZone(value: unknown): string {
  if (typeof value === "string" && value.length <= 64 && isZone(value)) return value;
  throw new HostError("bad_request", "timeZone must be an IANA time zone");
}

const isZone = (zone: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
