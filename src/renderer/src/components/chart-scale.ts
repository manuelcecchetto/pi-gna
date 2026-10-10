// Pure helpers for Charts.tsx: tick scales, heat levels, calendar frames and the category colour of each key.

const CHART_SLOTS = 8;
const HEAT_LEVELS = 4;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const DAY_MS = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

interface Ticks {
  max: number;
  step: number;
  ticks: number[];
}

/** Ticks from zero to a round top, about `count` intervals apart: steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(max: number, count = 4): Ticks {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, step: 1, ticks: [0, 1] };
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let index = 0; index * step <= top + step / 1000; index++) ticks.push(Number((index * step).toPrecision(12)));
  return { max: ticks.at(-1)!, step, ticks };
}

/** "<1%" for shares that round to nothing, else whole percent. */
export function formatShare(fraction: number): string {
  if (!(fraction > 0)) return "0%";
  const percent = fraction * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/** A stable slot per key (FNV-1a), so one model keeps its colour in every chart. */
export function colorSlot(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % CHART_SLOTS;
}

export const chartColor = (slot: number): string => `var(--chart-${(((slot % CHART_SLOTS) + CHART_SLOTS) % CHART_SLOTS) + 1})`;

/** Each key's colour in one chart: its hash slot, or the next free one when an earlier key (in sorted order) took it. */
export function colorScale(keys: string[]): (key: string) => string {
  const taken = new Set<number>();
  const slots = new Map<string, number>();
  for (const key of [...new Set(keys)].sort()) {
    let slot = colorSlot(key);
    for (let step = 1; step < CHART_SLOTS && taken.has(slot); step++) slot = (slot + 1) % CHART_SLOTS;
    taken.add(slot);
    slots.set(key, slot);
  }
  return (key) => chartColor(slots.get(key) ?? colorSlot(key));
}

/** Level 0 is an empty cell; 1 to HEAT_LEVELS scale with the square root of the share of the maximum. */
export function heatLevel(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(HEAT_LEVELS, Math.max(1, Math.ceil(Math.sqrt(Math.min(value, max) / max) * HEAT_LEVELS)));
}

const HEAT_MIX = [25, 45, 68, 92];

export function heatFill(level: number): string {
  if (level <= 0) return "color-mix(in srgb, var(--fg) 7%, transparent)";
  return `color-mix(in srgb, var(--accent) ${HEAT_MIX[level - 1]}%, transparent)`;
}

export function everyNth(count: number, fit: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, fit)));
}

export function addDays(date: string, days: number): string {
  return isoDate(utc(date) + days * DAY_MS);
}

export function dayOffset(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** Monday is 0. */
export function weekdayIndex(date: string): number {
  return (new Date(utc(date)).getUTCDay() + 6) % 7;
}

/** Monday-first week columns that cover `first` to `last`, from the Monday of `first`'s week. */
export function calendarFrame(first: string, last: string): { start: string; weeks: number } {
  const start = addDays(first, -weekdayIndex(first));
  return { start, weeks: Math.floor(dayOffset(start, last) / 7) + 1 };
}

export function formatDay(date: string): string {
  return new Date(utc(date)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function monthName(date: string): string {
  return new Date(utc(date)).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
}
