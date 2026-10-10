// Shapes of the usage analytics (Settings > Usage): the per-file facts the indexer caches, the query and the report the
// page renders. Types and constants only; docs/DESIGN.md "Usage" is the source of truth for what each one means.

/** Bump when FileUsageFacts or the way it is derived changes: cache entries of another version are read again. */
export const USAGE_FACTS_VERSION = 1;

/** pi-ai's only pricing tier edge: a turn whose input (input + cacheRead + cacheWrite) exceeds it is priced at the tier's rates. */
export const CONTEXT_TIER_EDGE = 272_000;

/** A gap between two messages longer than this is idle, not active time. */
export const ACTIVE_GAP_CAP_MS = 5 * 60_000;

/** Inclusive upper bounds of the context histogram bins; one more bin holds every turn above the last edge. */
export const CONTEXT_EDGES = [10_000, 50_000, 100_000, 150_000, 200_000, CONTEXT_TIER_EDGE, 500_000, 1_000_000] as const;

/** Inclusive upper bounds of the steps-per-prompt bins; one more bin holds every prompt above the last edge. */
export const STEP_EDGES = [1, 2, 5, 10, 20, 50] as const;

/** A turn that writes at least this much input and reads no cache counts as a cache miss. */
export const CACHE_MISS_MIN_INPUT = 10_000;

export const SOURCE_ROOTS = ["sessions", "atp"] as const;
export type SourceRoot = (typeof SOURCE_ROOTS)[number];

export const SURFACES = ["pigna-chat", "card", "atp-worker", "subagent", "ci", "terminal"] as const;
export type Surface = (typeof SURFACES)[number];

export const STOP_REASONS = ["toolUse", "stop", "length", "error", "aborted"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const ERROR_CATEGORIES = ["aborted", "rate-limit", "overloaded", "context-overflow", "network", "process", "other"] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const INSIGHT_IDS = ["long-context", "cache-misses", "errors", "aborts", "compactions", "subagents", "reasoning", "long-prompts"] as const;
export type InsightId = (typeof INSIGHT_IDS)[number];

/** Session files' providers whose list prices apply to another provider's model ids (claude-bridge runs Claude Code on a subscription). */
export const PRICE_PROVIDER_ALIASES: Readonly<Record<string, string>> = { "claude-bridge": "anthropic" };

export const USAGE_RANGES = ["7d", "14d", "30d", "90d", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** `pigna`: pi-gna's surfaces and their subagents; `all`: every session pi wrote on this Mac. */
export type UsageSource = "pigna" | "all";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A part of `output`, not added to it. */
  reasoning: number;
}

/** One provider and model's turns in one UTC hour of one file. */
export interface UsageBucket {
  /** Epoch milliseconds / 3_600_000. Local days, weekdays and hours are derived at query time, never stored. */
  hour: number;
  provider: string;
  model: string;
  turns: number;
  errorTurns: number;
  missTurns: number;
  /** USD as pi recorded it (zero for claude-bridge). */
  recordedCost: number;
  tokens: TokenCounts;
  /** The part of `tokens` from turns above CONTEXT_TIER_EDGE. */
  tierTokens: TokenCounts;
}

export interface ToolStat {
  calls: number;
  errors: number;
  /** Calls whose toolResult was found, the only ones with a duration. */
  timedCalls: number;
  durationMs: number;
  /** Tool calls a codemode run made inside itself (toolResult.nestedCalls). */
  nestedCalls: number;
}

export interface PromptStats {
  count: number;
  aborted: number;
  steps: number;
  toolCalls: number;
  wallMs: number;
  /** One count per STEP_EDGES bin. */
  stepHist: number[];
}

export interface SessionMeta {
  id: string;
  root: SourceRoot;
  path: string;
  surface: Surface;
  /** Whether pi-gna ran it: its own surfaces, or a subagent of one. */
  pigna: boolean;
  cwd: string;
  project: string;
  /** The parent session's id for a subagent (the header's parentSession). */
  parentId?: string;
  /** The name pi gave the session (session_info); untrusted text, shown as plain text only. */
  name?: string;
  firstAt: number;
  lastAt: number;
  activeMs: number;
}

export interface PendingCall {
  name: string;
  /** The assistant turn's timestamp: the start of the call. */
  at: number;
}

export interface OpenPrompt {
  steps: number;
  toolCalls: number;
  wallMs: number;
  aborted: boolean;
}

/** What a later append needs to continue the file without a re-read. */
export interface UsageResume {
  /** Tool calls whose toolResult has not been read yet, by toolCallId. */
  pending: Record<string, PendingCall>;
  /** Prompts whose next user message has arrived. */
  closed: PromptStats;
  /** The prompt the file currently ends in. */
  open?: OpenPrompt;
}

/** Everything the report needs from one session file, compact enough to keep in a cache for thousands of files. */
export interface FileUsageFacts {
  version: number;
  /** The file's size and mtime when it was read: the index compares them to decide a re-read. */
  size: number;
  mtimeMs: number;
  /** Bytes read through the last complete record; a torn last line stays unread until its end arrives. */
  consumedBytes: number;
  session: SessionMeta;
  buckets: UsageBucket[];
  tools: Record<string, ToolStat>;
  stops: Partial<Record<StopReason, number>>;
  errors: Partial<Record<ErrorCategory, number>>;
  /** One count per CONTEXT_EDGES bin, over every turn's input (input + cacheRead + cacheWrite). */
  contextHist: number[];
  thinking: Record<string, number>;
  prompts: PromptStats;
  compactions: number;
  compactedTokens: number;
  contextEdits: number;
  /** This file's subagents:record entries, counted by their status. */
  subagentRuns: Record<string, number>;
  /** Lines that are not JSON, and entries of a type pi does not write. Counted, never thrown. */
  skipped: { lines: number; entries: number };
  resume: UsageResume;
}

/** USD per million tokens, as pi-ai lists them. */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceTier {
  /** The turn's input (input + cacheRead + cacheWrite) must exceed this for the tier's rates to apply. */
  inputTokensAbove: number;
  rates: ModelRates;
}

export interface PriceEntry {
  provider: string;
  model: string;
  rates: ModelRates;
  /** Empty when the model has no tier. */
  tiers: PriceTier[];
}

export interface PriceTable {
  source: string;
  asOf: string;
  entries: PriceEntry[];
}

export interface UsageQuery {
  range: UsageRange | { from: number; to: number };
  source: UsageSource;
  /** A SessionMeta.project; the report then covers that project only. */
  project?: string;
  /** IANA zone the days, weekdays and hours are cut in; the Mac's zone when omitted. */
  timeZone?: string;
}

export interface CostTotals {
  /** API-equivalent cost at list price (estimate). */
  estimated: number;
  /** Cost pi recorded (provider billing where pi knows it). */
  recorded: number;
  /** Turns whose model has no price; left out of `estimated`. */
  unpricedTurns: number;
}

export interface UsageTotals {
  turns: number;
  sessions: number;
  prompts: number;
  toolCalls: number;
  activeMs: number;
  /** The four billed types; `reasoning` is inside `output`, so it is not summed here. */
  tokens: TokenCounts;
  /** cacheRead / (input + cacheRead + cacheWrite). */
  cacheHitRate: number;
  errorTurns: number;
  abortedPrompts: number;
  cost: CostTotals;
}

export interface UsageDay {
  /** YYYY-MM-DD in the query's zone. */
  day: string;
  turns: number;
  tokens: number;
  estimated: number;
  /** `provider/model` keys, one entry per model that had turns that day. */
  models: { key: string; tokens: number; estimated: number }[];
}

/** 168 cells: weekday (0 = Monday) * 24 + hour in the query's zone. */
export interface WeekHour {
  turns: number[];
  tokens: number[];
  estimated: number[];
}

export interface ModelRow {
  provider: string;
  model: string;
  turns: number;
  errorTurns: number;
  tokens: TokenCounts;
  estimated: number;
  recorded: number;
  priced: boolean;
}

export interface ProjectRow {
  project: string;
  label: string;
  sessions: number;
  turns: number;
  tokens: number;
  estimated: number;
  /** Sessions that ran in a card worktree of this project. */
  worktreeSessions: number;
}

/** A top-level session with its subagents' usage rolled in. */
export interface SessionRow {
  id: string;
  path: string;
  title: string;
  project: string;
  surface: Surface;
  firstAt: number;
  lastAt: number;
  activeMs: number;
  turns: number;
  prompts: number;
  tokens: number;
  estimated: number;
  subagents: number;
  /** Whether the Usage page can open it as a chat (pi-gna's surfaces). */
  openable: boolean;
}

export interface SurfaceRow {
  surface: Surface;
  sessions: number;
  turns: number;
  tokens: number;
  estimated: number;
}

export interface ToolRow {
  name: string;
  calls: number;
  errors: number;
  /** Mean duration of the timed calls; null when none was timed. */
  avgMs: number | null;
  nestedCalls: number;
}

export interface AgentHealth {
  stops: Partial<Record<StopReason, number>>;
  errors: Partial<Record<ErrorCategory, number>>;
  promptSteps: number[];
  contextHist: number[];
  compactions: number;
  compactedTokens: number;
  contextEdits: number;
  subagentRuns: Record<string, number>;
}

/** A five-hour block from the first turn in it, hour-aligned (the buckets are hours). */
export interface WindowRow {
  start: number;
  end: number;
  turns: number;
  tokens: number;
  estimated: number;
  sessions: number;
  rateLimits: number;
}

export interface Insight {
  id: InsightId;
  /** The share of its base (estimated cost, turns or prompts) the behaviour accounts for, 0..1. */
  share: number;
  count: number;
}

export interface UsageReportMeta {
  generatedAt: number;
  from: number;
  to: number;
  timeZone: string;
  source: UsageSource;
  project?: string;
  /** Session files that match the source, and how many of them are indexed; less than files while indexing. */
  files: number;
  indexedFiles: number;
  priceTable: { source: string; asOf: string };
}

export interface UsageReport {
  meta: UsageReportMeta;
  totals: UsageTotals;
  days: UsageDay[];
  weekHour: WeekHour;
  models: ModelRow[];
  projects: ProjectRow[];
  sessions: SessionRow[];
  surfaces: SurfaceRow[];
  tools: ToolRow[];
  health: AgentHealth;
  windows: WindowRow[];
  insights: Insight[];
}

/** The `usage.progress` event while the index is built. */
export interface UsageProgress {
  phase: "scan" | "index" | "done";
  done: number;
  total: number;
}
