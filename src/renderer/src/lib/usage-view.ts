// View mappings of the Usage report for its panels: how a report's rows become chart series and labels. The numbers
// themselves come from the report (shared/usage-report.ts); this file only picks, sums for display and formats.
import type { Bucket, Series } from "../components/Charts";
import { WEEKDAYS } from "../components/chart-scale";
import type { TokenCounts, UsageDay, WeekHour } from "../../../shared/usage";

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
