import type {
  FileUsageFacts,
  ModelRow,
  PriceEntry,
  PriceTable,
  ProjectRow,
  SessionRow,
  TokenCounts,
  UsageBucket,
  UsageDay,
  UsageQuery,
  UsageRange,
  UsageReport,
  UsageReportMeta,
  UsageTotals,
  WeekHour,
} from "./usage";
import { projectLabels } from "./usage-classify";
import { findPrice, largeContextRates, type PriceIndex, priceIndex, priceTokens } from "./usage-prices";

export type CoreUsageReport = Omit<UsageReport, "surfaces" | "tools" | "health" | "windows" | "insights">;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOP_SESSIONS = 10;
const PRESET_DAYS: Record<Exclude<UsageRange, "all">, number> = { "7d": 7, "14d": 14, "30d": 30, "90d": 90 };

interface Sum {
  turns: number;
  errorTurns: number;
  tokens: TokenCounts;
  estimated: number;
  recorded: number;
  unpricedTurns: number;
  unpricedTokens: number;
}

interface FileRow {
  fact: FileUsageFacts;
  sum: Sum;
}

interface SessionGroup {
  root: FileRow;
  sum: Sum;
  prompts: number;
  members: number;
  firstAt: number;
  lastAt: number;
  activeMs: number;
}

interface ZoneSlot {
  day: string;
  cell: number;
}

const emptyTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const newSum = (): Sum => ({ turns: 0, errorTurns: 0, tokens: emptyTokens(), estimated: 0, recorded: 0, unpricedTurns: 0, unpricedTokens: 0 });
const zeros = (length: number): number[] => Array.from({ length }, () => 0);
const addAt = (values: number[], index: number, amount: number): void => {
  values[index] = (values[index] ?? 0) + amount;
};
const billed = (tokens: TokenCounts): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
const cacheHitRate = (tokens: TokenCounts): number => {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return input === 0 ? 0 : tokens.cacheRead / input;
};
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function addTokens(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
}

function addSum(into: Sum, from: Sum): void {
  into.turns += from.turns;
  into.errorTurns += from.errorTurns;
  addTokens(into.tokens, from.tokens);
  into.estimated += from.estimated;
  into.recorded += from.recorded;
  into.unpricedTurns += from.unpricedTurns;
  into.unpricedTokens += from.unpricedTokens;
}

function addBucket(into: Sum, bucket: UsageBucket, estimate: number | undefined): void {
  into.turns += bucket.turns;
  into.errorTurns += bucket.errorTurns;
  addTokens(into.tokens, bucket.tokens);
  into.recorded += bucket.recordedCost;
  if (estimate === undefined) {
    into.unpricedTurns += bucket.turns;
    into.unpricedTokens += billed(bucket.tokens);
  } else into.estimated += estimate;
}

/** The part above the tier edge is priced at the tier's rates; the rest at the base rates. */
function estimateBucket(bucket: UsageBucket, price: PriceEntry): number {
  const { tokens, tierTokens } = bucket;
  const base = {
    input: tokens.input - tierTokens.input,
    output: tokens.output - tierTokens.output,
    cacheRead: tokens.cacheRead - tierTokens.cacheRead,
    cacheWrite: tokens.cacheWrite - tierTokens.cacheWrite,
  };
  return priceTokens(base, price.rates) + priceTokens(tierTokens, largeContextRates(price));
}

function priceLookup(index: PriceIndex): (provider: string, model: string) => PriceEntry | undefined {
  const cache = new Map<string, PriceEntry | null>();
  return (provider, model) => {
    const key = `${provider}\u0000${model}`;
    let price = cache.get(key);
    if (price === undefined) {
      price = findPrice(index, provider, model) ?? null;
      cache.set(key, price);
    }
    return price ?? undefined;
  };
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function calendarDays(first: string, last: string): string[] {
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Local calendar facts of a zone. Hour buckets are placed at their midpoint, which is exact for whole-hour offsets. */
function zoneClock(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const wall = (ms: number) => {
    const p = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const part of format.formatToParts(ms)) if (part.type in p) p[part.type as keyof typeof p] = Number(part.value);
    const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
    return { day, hour: p.hour, offset };
  };
  const midnight = (day: string): number => {
    const guess = Date.parse(`${day}T00:00:00Z`);
    const first = guess - wall(guess).offset;
    return guess - wall(first).offset;
  };
  const slots = new Map<number, ZoneSlot>();
  const slot = (hour: number): ZoneSlot => {
    let found = slots.get(hour);
    if (!found) {
      const local = wall(hour * HOUR_MS + HOUR_MS / 2);
      const weekday = (new Date(`${local.day}T00:00:00Z`).getUTCDay() + 6) % 7;
      found = { day: local.day, cell: weekday * 24 + local.hour };
      slots.set(hour, found);
    }
    return found;
  };
  return { dayOf: (ms: number) => wall(ms).day, midnight, slot };
}

function resolveRange(range: UsageQuery["range"], now: number, clock: ReturnType<typeof zoneClock>, scoped: readonly FileUsageFacts[]) {
  if (typeof range === "object") return range;
  const to = Math.ceil(now / HOUR_MS) * HOUR_MS;
  if (range === "all") {
    let from = to;
    for (const fact of scoped) for (const bucket of fact.buckets) from = Math.min(from, bucket.hour * HOUR_MS);
    return { from, to };
  }
  return { from: clock.midnight(addDays(clock.dayOf(now), 1 - PRESET_DAYS[range])), to };
}

function rootOf(row: FileRow, byId: Map<string, FileRow>): FileRow {
  let current = row;
  const seen = new Set<string>([row.fact.session.id]);
  for (;;) {
    const parentId = current.fact.session.parentId;
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (!parent || seen.has(parent.fact.session.id)) return current;
    seen.add(parent.fact.session.id);
    current = parent;
  }
}

/**
 * The core of the usage report: the headline, the daily and weekday-hour series, the models, projects and top sessions.
 * Pure: reads the facts, the price table, the query and `now`; `files` is the number of session files the index holds
 * for the source. A file counts when it has a turn in the range; its prompts, tools and active time are its whole-file
 * totals, since the facts are not bucketed by time below the hour.
 */
export function buildCoreReport(
  facts: readonly FileUsageFacts[],
  query: UsageQuery,
  prices: PriceTable,
  now: number,
  files: number,
): CoreUsageReport {
  const timeZone = query.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = zoneClock(timeZone);
  const priceOf = priceLookup(priceIndex(prices));
  const sourced = facts.filter((fact) => query.source === "all" || fact.session.pigna);
  const scoped = sourced.filter((fact) => query.project === undefined || fact.session.project === query.project);
  const { from, to } = resolveRange(query.range, now, clock, scoped);

  const dayAcc = new Map<string, { sum: Sum; models: Map<string, { tokens: number; estimated: number }> }>();
  const newDay = () => ({ sum: newSum(), models: new Map<string, { tokens: number; estimated: number }>() });
  if (from < to) for (const day of calendarDays(clock.dayOf(from), clock.dayOf(to - 1))) dayAcc.set(day, newDay());
  const weekHour: WeekHour = { turns: zeros(168), tokens: zeros(168), estimated: zeros(168) };
  const total = newSum();
  const modelAcc = new Map<string, { provider: string; model: string; priced: boolean; sum: Sum }>();
  const rows: FileRow[] = [];

  for (const fact of scoped) {
    const inRange = fact.buckets.filter((bucket) => {
      const mid = bucket.hour * HOUR_MS + HOUR_MS / 2;
      return mid >= from && mid < to;
    });
    if (inRange.length === 0) continue;
    const row: FileRow = { fact, sum: newSum() };
    for (const bucket of inRange) {
      const price = priceOf(bucket.provider, bucket.model);
      const estimate = price === undefined ? undefined : estimateBucket(bucket, price);
      const tokens = billed(bucket.tokens);
      addBucket(row.sum, bucket, estimate);
      addBucket(total, bucket, estimate);

      const { day, cell } = clock.slot(bucket.hour);
      let dayEntry = dayAcc.get(day);
      if (!dayEntry) dayAcc.set(day, (dayEntry = newDay()));
      addBucket(dayEntry.sum, bucket, estimate);
      const key = `${bucket.provider}/${bucket.model}`;
      const dayModel = dayEntry.models.get(key) ?? { tokens: 0, estimated: 0 };
      dayModel.tokens += tokens;
      dayModel.estimated += estimate ?? 0;
      dayEntry.models.set(key, dayModel);

      addAt(weekHour.turns, cell, bucket.turns);
      addAt(weekHour.tokens, cell, tokens);
      addAt(weekHour.estimated, cell, estimate ?? 0);

      let model = modelAcc.get(key);
      if (!model) modelAcc.set(key, (model = { provider: bucket.provider, model: bucket.model, priced: price !== undefined, sum: newSum() }));
      addBucket(model.sum, bucket, estimate);
    }
    rows.push(row);
  }

  const days: UsageDay[] = [...dayAcc]
    .sort(([a], [b]) => compare(a, b))
    .map(([day, entry]) => ({
      day,
      turns: entry.sum.turns,
      tokens: billed(entry.sum.tokens),
      estimated: entry.sum.estimated,
      models: [...entry.models].sort(([a], [b]) => compare(a, b)).map(([key, value]) => ({ key, ...value })),
    }));

  const totalBilled = billed(total.tokens);
  const models: ModelRow[] = [...modelAcc.values()]
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      turns: entry.sum.turns,
      errorTurns: entry.sum.errorTurns,
      tokens: entry.sum.tokens,
      estimated: entry.sum.estimated,
      recorded: entry.sum.recorded,
      priced: entry.priced,
      share: totalBilled === 0 ? 0 : billed(entry.sum.tokens) / totalBilled,
      cacheHitRate: cacheHitRate(entry.sum.tokens),
    }))
    .sort(
      (a, b) =>
        b.estimated - a.estimated || billed(b.tokens) - billed(a.tokens) || compare(`${a.provider}/${a.model}`, `${b.provider}/${b.model}`),
    );

  const byId = new Map(rows.map((row) => [row.fact.session.id, row]));
  const groups = new Map<string, SessionGroup>();
  for (const row of rows) {
    const root = rootOf(row, byId);
    const id = root.fact.session.id;
    let group = groups.get(id);
    if (!group) {
      group = { root, sum: newSum(), prompts: 0, members: 0, firstAt: Infinity, lastAt: -Infinity, activeMs: 0 };
      groups.set(id, group);
    }
    addSum(group.sum, row.sum);
    group.prompts += row.fact.prompts.count;
    group.members += 1;
    group.firstAt = Math.min(group.firstAt, row.fact.session.firstAt);
    group.lastAt = Math.max(group.lastAt, row.fact.session.lastAt);
    group.activeMs += row.fact.session.activeMs;
  }
  const topGroups = [...groups.values()]
    .sort((a, b) => b.sum.estimated - a.sum.estimated || billed(b.sum.tokens) - billed(a.sum.tokens) || compare(a.root.fact.session.id, b.root.fact.session.id))
    .slice(0, TOP_SESSIONS);
  const sessions: SessionRow[] = topGroups.map((group) => {
    const meta = group.root.fact.session;
    return {
      id: meta.id,
      path: meta.path,
      title: meta.name ?? meta.id,
      project: meta.project,
      surface: meta.surface,
      firstAt: group.firstAt,
      lastAt: group.lastAt,
      activeMs: group.activeMs,
      turns: group.sum.turns,
      prompts: group.prompts,
      tokens: billed(group.sum.tokens),
      estimated: group.sum.estimated,
      subagents: group.members - 1,
      openable: meta.pigna && meta.parentId === undefined,
    };
  });

  const projectAcc = new Map<string, { sessions: number; worktreeSessions: number; lastAt: number; sum: Sum }>();
  for (const row of rows) {
    const { project, card, lastAt } = row.fact.session;
    let entry = projectAcc.get(project);
    if (!entry) projectAcc.set(project, (entry = { sessions: 0, worktreeSessions: 0, lastAt: -Infinity, sum: newSum() }));
    entry.sessions += 1;
    if (card !== undefined) entry.worktreeSessions += 1;
    entry.lastAt = Math.max(entry.lastAt, lastAt);
    addSum(entry.sum, row.sum);
  }
  const labels = projectLabels([...projectAcc.keys()]);
  const projects: ProjectRow[] = [...projectAcc]
    .map(([project, entry]) => ({
      project,
      label: labels.get(project) ?? project,
      sessions: entry.sessions,
      turns: entry.sum.turns,
      tokens: billed(entry.sum.tokens),
      estimated: entry.sum.estimated,
      worktreeSessions: entry.worktreeSessions,
      lastAt: entry.lastAt,
    }))
    .sort((a, b) => b.estimated - a.estimated || b.tokens - a.tokens || compare(a.project, b.project));

  const currentStreak = streakEnding(days);
  const longestStreak = longestRun(days);
  const totals: UsageTotals = {
    turns: total.turns,
    sessions: rows.length,
    prompts: rows.reduce((sum, row) => sum + row.fact.prompts.count, 0),
    toolCalls: rows.reduce((sum, row) => sum + Object.values(row.fact.tools).reduce((calls, tool) => calls + tool.calls, 0), 0),
    activeMs: rows.reduce((sum, row) => sum + row.fact.session.activeMs, 0),
    tokens: total.tokens,
    cacheHitRate: cacheHitRate(total.tokens),
    errorTurns: total.errorTurns,
    abortedPrompts: rows.reduce((sum, row) => sum + row.fact.prompts.aborted, 0),
    cost: {
      estimated: total.estimated,
      recorded: total.recorded,
      unpricedTurns: total.unpricedTurns,
      unpricedShare: totalBilled === 0 ? 0 : total.unpricedTokens / totalBilled,
    },
    currentStreak,
    longestStreak,
    topModel: models[0] ? `${models[0].provider}/${models[0].model}` : null,
  };

  const meta: UsageReportMeta = {
    generatedAt: now,
    from,
    to,
    timeZone,
    source: query.source,
    files,
    indexedFiles: sourced.length,
    priceTable: { source: prices.source, asOf: prices.asOf },
    ...(query.project === undefined ? {} : { project: query.project }),
  };

  return { meta, totals, days, weekHour, models, projects, sessions };
}

function streakEnding(days: readonly UsageDay[]): number {
  const last = days.at(-1);
  let count = 0;
  for (let i = last?.turns === 0 ? days.length - 2 : days.length - 1; i >= 0 && (days[i]?.turns ?? 0) > 0; i--) count += 1;
  return count;
}

function longestRun(days: readonly UsageDay[]): number {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.turns > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
