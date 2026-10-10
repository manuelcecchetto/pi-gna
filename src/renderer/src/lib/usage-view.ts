// View mappings of the Usage report for its panels: how a report's rows become chart series and labels. The numbers
// themselves come from the report (shared/usage-report.ts); this file only picks, sums for display and formats.
import type { Amount, Bucket, Series } from "../components/Charts";
import { WEEKDAYS } from "../components/chart-scale";
import {
  CONTEXT_TIER_EDGE,
  type ErrorCategory,
  EXPENSIVE_OUTPUT_RATE,
  type Insight,
  type InsightId,
  type ModelRow,
  STEP_EDGES,
  type StopReason,
  type Surface,
  type SurfaceRow,
  type TokenCounts,
  type ToolRow,
  type UsageDay,
  type WeekHour,
} from "../../../shared/usage";
import { formatCompact, formatDuration } from "./format";

export type Measure = "tokens" | "cost" | "turns";

/** The most model series a stacked bar shows before the rest fold into "Other models". */
export const MODEL_SERIES_MAX = 7;
/** The calendar shows at most this many days, the last 26 weeks of the range. */
export const CALENDAR_DAYS = 182;

const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const UTC = { timeZone: "UTC" } as const;

export const billedTokens = (tokens: TokenCounts): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

export const usd = (value: number): string => (value > 0 && value < 0.01 ? "<$0.01" : dollars.format(value));

export const percentOf = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

export const hoursOf = (ms: number): string => `${(ms / 3_600_000).toFixed(1)} h`;

export const shortDay = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...UTC });

const valueOf = (measure: Exclude<Measure, "turns">) => (row: { tokens: number; estimated: number }) => (measure === "tokens" ? row.tokens : row.estimated);

/** One stacked bar per day: each model's tokens or estimated cost, the smallest models folded into "Other models". */
export function modelDayBars(days: UsageDay[], measure: Exclude<Measure, "turns">): { series: Series[]; buckets: Bucket[] } {
  const amount = valueOf(measure);
  const totals = new Map<string, number>();
  for (const day of days) for (const model of day.models) totals.set(model.key, (totals.get(model.key) ?? 0) + amount(model));
  const ranked = [...totals].filter(([, total]) => total > 0).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([key]) => key);
  const shown = new Set(ranked.slice(0, MODEL_SERIES_MAX));
  const series: Series[] = ranked.slice(0, MODEL_SERIES_MAX).map((key) => ({ key, label: key }));
  if (ranked.length > MODEL_SERIES_MAX) series.push({ key: "other", label: "Other models" });
  const buckets = days.map((day) => {
    const values: Record<string, number> = {};
    for (const model of day.models) {
      const key = shown.has(model.key) ? model.key : "other";
      values[key] = (values[key] ?? 0) + amount(model);
    }
    return { label: shortDay(day.day), values };
  });
  return { series, buckets };
}

/** Turns are not kept per model per day, so the turns view is one series. */
export function turnDayBars(days: UsageDay[]): { series: Series[]; buckets: Bucket[] } {
  return {
    series: [{ key: "turns", label: "Turns" }],
    buckets: days.map((day) => ({ label: shortDay(day.day), values: { turns: day.turns } })),
  };
}

export function calendarValues(days: UsageDay[], measure: "cost" | "tokens"): { date: string; value: number }[] {
  return days.slice(-CALENDAR_DAYS).map((day) => ({ date: day.day, value: measure === "cost" ? day.estimated : day.tokens }));
}

/** Rows of weekdays (Monday first) by 24 hour columns, from the report's weekday * 24 + hour cells. */
export function weekHourRows(week: WeekHour, measure: Measure): number[][] {
  const cells = measure === "turns" ? week.turns : measure === "tokens" ? week.tokens : week.estimated;
  return Array.from({ length: WEEKDAYS.length }, (_, row) => cells.slice(row * 24, row * 24 + 24));
}

export const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));

export const SURFACE_LABELS: Record<Surface, string> = {
  "pigna-chat": "pi-gna chats",
  card: "Card worktrees",
  "atp-worker": "ATP workers",
  subagent: "Subagents",
  ci: "CI runners",
  terminal: "Terminal pi",
};

/** The surfaces with any tokens or cost in the range, in the report's row order. */
export function surfaceParts(rows: SurfaceRow[], measure: Exclude<Measure, "turns">): Amount[] {
  return rows
    .map((row) => ({ key: row.surface, label: SURFACE_LABELS[row.surface], value: measure === "tokens" ? row.tokens : row.estimated }))
    .filter((part) => part.value > 0);
}

export const TOOL_BARS_MAX = 12;

/** Calls per tool for the first TOOL_BARS_MAX rows, which the report keeps most-called first. */
export const toolBars = (rows: ToolRow[]): Amount[] => rows.slice(0, TOOL_BARS_MAX).map((row) => ({ key: row.name, label: row.name, value: row.calls }));

export const toolSummary = (row: ToolRow): string =>
  `${percentOf(row.errorRate)} failed · ${row.avgMs === null ? "no timing" : `${formatDuration(row.avgMs)} avg`}`;

export const STOP_LABELS: Record<StopReason, string> = {
  toolUse: "Tool use",
  stop: "Finished",
  length: "Length limit",
  error: "Error",
  aborted: "Aborted",
};

export const ERROR_LABELS: Record<ErrorCategory, string> = {
  aborted: "Aborted",
  "rate-limit": "Rate limit",
  overloaded: "Overloaded",
  "context-overflow": "Context overflow",
  network: "Network",
  process: "Process killed",
  other: "Other",
};

/** Counts keyed by a category as bar rows, in the label table's order; zero rows are left out. */
export function labelledCounts<K extends string>(counts: Partial<Record<K, number>>, labels: Record<K, string>): Amount[] {
  return (Object.keys(labels) as K[]).flatMap((key) => {
    const value = counts[key] ?? 0;
    return value > 0 ? [{ key, label: labels[key], value }] : [];
  });
}

/** One label per bin binOf makes over STEP_EDGES: up to 1, then each range up to the next edge, then over the last. */
export const STEP_BIN_LABELS = ["1", "2", "3–5", "6–10", "11–20", "21–50", "over 50"];

/** One label per bin binOf makes over CONTEXT_EDGES: the bin's upper edge in input tokens, the last one open. */
export const CONTEXT_BIN_LABELS = ["≤10k", "≤50k", "≤100k", "≤150k", "≤200k", "≤272k", "≤500k", "≤1M", ">1M"];

export const plural = (value: number, one: string): string => `${value.toLocaleString()} ${value === 1 ? one : `${one}s`}`;

export const INSIGHT_LABELS: Record<InsightId, string> = {
  "long-context": "Long context",
  "cache-misses": "Cache misses",
  errors: "Error turns",
  "bash-errors": "Failing bash calls",
  aborts: "Aborted prompts",
  compactions: "Compactions",
  subagents: "Subagent turns",
  "expensive-subagents": "Expensive subagents",
  reasoning: "Reasoning tokens",
  "long-prompts": "Long prompts",
};

const RULE_UNITS: Record<Exclude<InsightId, "compactions">, string> = {
  "long-context": "of est. cost",
  "cache-misses": "of input tokens",
  errors: "of turns",
  "bash-errors": "of bash calls",
  aborts: "of prompts",
  subagents: "of turns",
  "expensive-subagents": "of subagent est. cost",
  reasoning: "of output tokens",
  "long-prompts": "of prompts",
};

export interface InsightFigures {
  value: string;
  threshold: string;
  detail: string;
}

/** A rule's value and threshold in its own unit, and the counts behind its share. */
export function insightFigures(insight: Insight): InsightFigures {
  if (insight.id === "compactions") {
    return {
      value: `${insight.value.toFixed(1)} prompts per compaction`,
      threshold: `${insight.threshold} prompts or fewer`,
      detail: insightDetail(insight),
    };
  }
  return { value: `${percentOf(insight.value)} ${RULE_UNITS[insight.id]}`, threshold: percentOf(insight.threshold), detail: insightDetail(insight) };
}

function insightDetail({ id, count, base }: Insight): string {
  const n = (value: number) => value.toLocaleString();
  switch (id) {
    case "long-context":
      return `${n(count)} turns above ${formatCompact(CONTEXT_TIER_EDGE)} input, of ${usd(base)} estimated`;
    case "cache-misses":
      return `${formatCompact(count)} of ${formatCompact(base)} input tokens not read from cache`;
    case "errors":
    case "subagents":
      return `${n(count)} of ${n(base)} turns`;
    case "bash-errors":
      return `${n(count)} of ${n(base)} bash calls failed`;
    case "aborts":
      return `${n(count)} of ${n(base)} prompts aborted`;
    case "compactions":
      return `${n(count)} compactions in ${n(base)} prompts`;
    case "expensive-subagents":
      return `${n(count)} subagent turns on models at $${EXPENSIVE_OUTPUT_RATE} or more per M output, of ${usd(base)} subagent estimated`;
    case "reasoning":
      return `${formatCompact(count)} of ${formatCompact(base)} output tokens`;
    case "long-prompts":
      return `${n(count)} of ${n(base)} prompts ran over ${STEP_EDGES.at(-1)} steps`;
  }
}

export type ModelSortKey = "model" | "turns" | "tokens" | "estimated" | "share" | "cacheHitRate";
export interface ModelSort {
  key: ModelSortKey;
  desc: boolean;
}

const modelName = (row: ModelRow): string => `${row.provider}/${row.model}`;
const byModelName = (a: ModelRow, b: ModelRow): number => (modelName(a) < modelName(b) ? -1 : modelName(a) > modelName(b) ? 1 : 0);
const MODEL_VALUE: Record<Exclude<ModelSortKey, "model">, (row: ModelRow) => number> = {
  turns: (row) => row.turns,
  tokens: (row) => billedTokens(row.tokens),
  estimated: (row) => row.estimated,
  share: (row) => row.share,
  cacheHitRate: (row) => row.cacheHitRate,
};

/** The models in a column's order; ties, and the model column itself, fall back to the name, A to Z. */
export function sortModels(rows: readonly ModelRow[], { key, desc }: ModelSort): ModelRow[] {
  const sign = desc ? -1 : 1;
  const value = key === "model" ? undefined : MODEL_VALUE[key];
  return [...rows].sort((a, b) => sign * (value ? value(a) - value(b) : byModelName(a, b)) || byModelName(a, b));
}
