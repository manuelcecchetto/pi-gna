import {
  CONTEXT_EDGES,
  CONTEXT_TIER_EDGE,
  EXPENSIVE_OUTPUT_RATE,
  INSIGHT_MAX,
  INSIGHT_MIN_SHARE,
  STEP_EDGES,
  SURFACES,
  TOP_WINDOWS,
  WINDOW_MS,
} from "./usage";
import type {
  AgentHealth,
  FileUsageFacts,
  Insight,
  ModelRow,
  PriceEntry,
  PriceTable,
  ProjectRow,
  SessionRow,
  Surface,
  SurfaceRow,
  TokenCounts,
  ToolRow,
  ToolsReport,
  ToolStat,
  UsageBucket,
  UsageDay,
  UsageQuery,
  UsageRange,
  UsageReport,
  UsageReportMeta,
  UsageTotals,
  WeekHour,
  WindowRow,
  WindowsReport,
} from "./usage";
import { projectLabels } from "./usage-classify";
import { findPrice, largeContextRates, type PriceIndex, priceIndex, priceTokens } from "./usage-prices";

export type CoreUsageReport = Omit<UsageReport, "surfaces" | "tools" | "health" | "windows" | "insights">;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOP_SESSIONS = 10;
const TOP_FAILING_TOOLS = 5;
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

function scopeOf(facts: readonly FileUsageFacts[], query: UsageQuery, prices: PriceTable, now: number) {
  const timeZone = query.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = zoneClock(timeZone);
  const priceOf = priceLookup(priceIndex(prices));
  const sourced = facts.filter((fact) => query.source === "all" || fact.session.pigna);
  const scoped = sourced.filter((fact) => query.project === undefined || fact.session.project === query.project);
  const { from, to } = resolveRange(query.range, now, clock, scoped);
  return { timeZone, clock, priceOf, sourced, scoped, from, to };
}

const bucketInRange = (bucket: UsageBucket, from: number, to: number): boolean => {
  const mid = bucket.hour * HOUR_MS + HOUR_MS / 2;
  return mid >= from && mid < to;
};

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
  const { timeZone, clock, priceOf, sourced, scoped, from, to } = scopeOf(facts, query, prices, now);

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

type Scope = ReturnType<typeof scopeOf>;
type PriceOf = ReturnType<typeof priceLookup>;

interface RangeRow {
  fact: FileUsageFacts;
  buckets: UsageBucket[];
}

function rangeRowsOf(scope: Scope): RangeRow[] {
  const rows: RangeRow[] = [];
  for (const fact of scope.scoped) {
    const buckets = fact.buckets.filter((bucket) => bucketInRange(bucket, scope.from, scope.to));
    if (buckets.length > 0) rows.push({ fact, buckets });
  }
  return rows;
}

function estimateOf(bucket: UsageBucket, priceOf: PriceOf): number | undefined {
  const price = priceOf(bucket.provider, bucket.model);
  return price === undefined ? undefined : estimateBucket(bucket, price);
}

function sumBuckets(buckets: readonly UsageBucket[], priceOf: PriceOf): Sum {
  const sum = newSum();
  for (const bucket of buckets) addBucket(sum, bucket, estimateOf(bucket, priceOf));
  return sum;
}

function addCounts<K extends string>(into: Partial<Record<K, number>>, from: Partial<Record<K, number>>): void {
  for (const key of Object.keys(from) as K[]) into[key] = (into[key] ?? 0) + (from[key] ?? 0);
}

function addEach(into: number[], from: readonly number[]): void {
  from.forEach((count, index) => addAt(into, index, count));
}

function toolsOf(rows: RangeRow[]): ToolsReport {
  const acc = new Map<string, ToolStat>();
  for (const { fact } of rows) {
    for (const [name, stat] of Object.entries(fact.tools)) {
      const entry = acc.get(name) ?? { calls: 0, errors: 0, timedCalls: 0, durationMs: 0, nestedCalls: 0 };
      entry.calls += stat.calls;
      entry.errors += stat.errors;
      entry.timedCalls += stat.timedCalls;
      entry.durationMs += stat.durationMs;
      entry.nestedCalls += stat.nestedCalls;
      acc.set(name, entry);
    }
  }
  const all: ToolRow[] = [...acc]
    .map(([name, stat]) => ({
      name,
      calls: stat.calls,
      errors: stat.errors,
      errorRate: stat.calls === 0 ? 0 : stat.errors / stat.calls,
      avgMs: stat.timedCalls === 0 ? null : stat.durationMs / stat.timedCalls,
      nestedCalls: stat.nestedCalls,
    }))
    .sort((a, b) => b.calls - a.calls || compare(a.name, b.name));
  const topFailing = all
    .filter((row) => row.errors > 0)
    .sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate || compare(a.name, b.name))
    .slice(0, TOP_FAILING_TOOLS);
  return { rows: all, topFailing, nestedCalls: all.reduce((sum, row) => sum + row.nestedCalls, 0) };
}

function healthOf(rows: RangeRow[]): AgentHealth {
  const health: AgentHealth = {
    stops: {},
    errors: {},
    promptSteps: zeros(STEP_EDGES.length + 1),
    contextHist: zeros(CONTEXT_EDGES.length + 1),
    compactions: 0,
    compactedTokens: 0,
    contextEdits: 0,
    compactingSessions: 0,
    editingSessions: 0,
    prompts: 0,
    abortedPrompts: 0,
    abortRate: 0,
    stepsPerPrompt: 0,
    toolCallsPerPrompt: 0,
    subagentRuns: {},
  };
  let steps = 0;
  let toolCalls = 0;
  for (const { fact } of rows) {
    addCounts(health.stops, fact.stops);
    addCounts(health.errors, fact.errors);
    addEach(health.promptSteps, fact.prompts.stepHist);
    addEach(health.contextHist, fact.contextHist);
    health.compactions += fact.compactions;
    health.compactedTokens += fact.compactedTokens;
    health.contextEdits += fact.contextEdits;
    if (fact.compactions > 0) health.compactingSessions += 1;
    if (fact.contextEdits > 0) health.editingSessions += 1;
    health.prompts += fact.prompts.count;
    health.abortedPrompts += fact.prompts.aborted;
    steps += fact.prompts.steps;
    toolCalls += fact.prompts.toolCalls;
    addCounts(health.subagentRuns, fact.subagentRuns);
  }
  if (health.prompts > 0) {
    health.abortRate = health.abortedPrompts / health.prompts;
    health.stepsPerPrompt = steps / health.prompts;
    health.toolCallsPerPrompt = toolCalls / health.prompts;
  }
  return health;
}

function surfacesOf(rows: RangeRow[], priceOf: PriceOf): SurfaceRow[] {
  const fileRows: FileRow[] = rows.map(({ fact, buckets }) => ({ fact, sum: sumBuckets(buckets, priceOf) }));
  const byId = new Map(fileRows.map((row) => [row.fact.session.id, row]));
  const acc = Object.fromEntries(
    SURFACES.map((surface) => [surface, { surface, sessions: 0, turns: 0, tokens: 0, estimated: 0, subagentTokens: 0, subagentEstimated: 0 }]),
  ) as Record<Surface, SurfaceRow>;
  for (const row of fileRows) {
    const root = rootOf(row, byId);
    const entry = acc[root.fact.session.surface];
    if (root === row) entry.sessions += 1;
    entry.turns += row.sum.turns;
    entry.tokens += billed(row.sum.tokens);
    entry.estimated += row.sum.estimated;
    if (root !== row) {
      entry.subagentTokens += billed(row.sum.tokens);
      entry.subagentEstimated += row.sum.estimated;
    }
  }
  return SURFACES.map((surface) => acc[surface]);
}

interface WindowAcc {
  start: number;
  end: number;
  turns: number;
  tokens: number;
  estimated: number;
  sessions: Set<string>;
}

/** Five-hour blocks over the hour buckets: a block starts at the first turn after the previous one ends, hour-aligned. */
function windowsOf(rows: RangeRow[], priceOf: PriceOf, now: number): WindowsReport {
  const hours = new Map<number, Omit<WindowAcc, "start" | "end">>();
  for (const { fact, buckets } of rows) {
    for (const bucket of buckets) {
      const entry = hours.get(bucket.hour) ?? { turns: 0, tokens: 0, estimated: 0, sessions: new Set<string>() };
      entry.turns += bucket.turns;
      entry.tokens += billed(bucket.tokens);
      entry.estimated += estimateOf(bucket, priceOf) ?? 0;
      entry.sessions.add(fact.session.id);
      hours.set(bucket.hour, entry);
    }
  }
  const blocks: WindowAcc[] = [];
  let block: WindowAcc | undefined;
  for (const [hour, entry] of [...hours].sort(([a], [b]) => a - b)) {
    const start = hour * HOUR_MS;
    if (!block || start >= block.end) {
      block = { start, end: start + WINDOW_MS, turns: 0, tokens: 0, estimated: 0, sessions: new Set<string>() };
      blocks.push(block);
    }
    block.turns += entry.turns;
    block.tokens += entry.tokens;
    block.estimated += entry.estimated;
    for (const id of entry.sessions) block.sessions.add(id);
  }
  const windows: WindowRow[] = blocks.map((item) => {
    const elapsedMs = Math.min(item.end, now) - item.start;
    return {
      start: item.start,
      end: item.end,
      turns: item.turns,
      tokens: item.tokens,
      estimated: item.estimated,
      sessions: item.sessions.size,
      burnRate: elapsedMs > 0 ? item.tokens / (elapsedMs / 60_000) : 0,
      active: item.start <= now && now < item.end,
    };
  });
  return {
    count: windows.length,
    top: [...windows].sort((a, b) => b.tokens - a.tokens || a.start - b.start).slice(0, TOP_WINDOWS),
    current: windows.find((item) => item.active) ?? null,
  };
}

function insightsOf(rows: RangeRow[], priceOf: PriceOf, health: AgentHealth, tools: ToolsReport): Insight[] {
  const all = newSum();
  let tierCost = 0;
  let inputBilled = 0;
  let missTokens = 0;
  let subagentTurns = 0;
  let subagentEstimated = 0;
  let expensiveTurns = 0;
  let expensiveEstimated = 0;
  for (const { fact, buckets } of rows) {
    const subagent = fact.session.parentId !== undefined;
    for (const bucket of buckets) {
      const price = priceOf(bucket.provider, bucket.model);
      const estimate = estimateOf(bucket, priceOf);
      addBucket(all, bucket, estimate);
      if (price !== undefined) tierCost += priceTokens(bucket.tierTokens, largeContextRates(price));
      inputBilled += bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite;
      missTokens += bucket.tokens.input + bucket.tokens.cacheWrite;
      if (subagent) {
        subagentTurns += bucket.turns;
        subagentEstimated += estimate ?? 0;
        if (price !== undefined && price.rates.output >= EXPENSIVE_OUTPUT_RATE) {
          expensiveTurns += bucket.turns;
          expensiveEstimated += estimate ?? 0;
        }
      }
    }
  }
  const bash = tools.rows.find((row) => row.name === "bash");
  const longPrompts = health.promptSteps.at(-1) ?? 0;
  const overEdge = health.contextHist.slice(CONTEXT_EDGES.indexOf(CONTEXT_TIER_EDGE) + 1).reduce((sum, count) => sum + count, 0);
  const reasoning = all.tokens.reasoning;
  const candidates: Insight[] = [
    {
      id: "long-context",
      share: all.estimated === 0 ? 0 : tierCost / all.estimated,
      count: overEdge,
      base: all.estimated,
      value: all.estimated === 0 ? 0 : tierCost / all.estimated,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Compact or start a fresh chat before the context passes 272k tokens.",
    },
    {
      id: "cache-misses",
      share: inputBilled === 0 ? 0 : missTokens / inputBilled,
      count: missTokens,
      base: inputBilled,
      value: inputBilled === 0 ? 0 : missTokens / inputBilled,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Keep the prompt prefix stable: a skill or tool added mid-chat rewrites it and misses the cache.",
    },
    {
      id: "errors",
      share: all.turns === 0 ? 0 : all.errorTurns / all.turns,
      count: all.errorTurns,
      base: all.turns,
      value: all.turns === 0 ? 0 : all.errorTurns / all.turns,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Check the provider's status page before retrying.",
    },
    {
      id: "bash-errors",
      share: bash?.errorRate ?? 0,
      count: bash?.errors ?? 0,
      base: bash?.calls ?? 0,
      value: bash?.errorRate ?? 0,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Check the failing bash commands; a repeated failure usually has one cause.",
    },
    {
      id: "aborts",
      share: health.abortRate,
      count: health.abortedPrompts,
      base: health.prompts,
      value: health.abortRate,
      threshold: INSIGHT_MIN_SHARE,
      tip: "A long wait ended early; check whether the task was what you wanted.",
    },
    {
      id: "compactions",
      share: health.prompts === 0 ? 0 : health.compactions / health.prompts,
      count: health.compactions,
      base: health.prompts,
      value: health.compactions === 0 ? 0 : health.prompts / health.compactions,
      threshold: Math.round(1 / INSIGHT_MIN_SHARE),
      tip: "A compaction is cheap; compacting early keeps the context below the tier.",
    },
    {
      id: "subagents",
      share: all.turns === 0 ? 0 : subagentTurns / all.turns,
      count: subagentTurns,
      base: all.turns,
      value: all.turns === 0 ? 0 : subagentTurns / all.turns,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Review the turn budgets of the subagents that ran long.",
    },
    {
      id: "expensive-subagents",
      share: subagentEstimated === 0 ? 0 : expensiveEstimated / subagentEstimated,
      count: expensiveTurns,
      base: subagentEstimated,
      value: subagentEstimated === 0 ? 0 : expensiveEstimated / subagentEstimated,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Give search and read subagents a cheaper model.",
    },
    {
      id: "reasoning",
      share: all.tokens.output === 0 ? 0 : reasoning / all.tokens.output,
      count: reasoning,
      base: all.tokens.output,
      value: all.tokens.output === 0 ? 0 : reasoning / all.tokens.output,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Lower the thinking level for routine turns.",
    },
    {
      id: "long-prompts",
      share: health.prompts === 0 ? 0 : longPrompts / health.prompts,
      count: longPrompts,
      base: health.prompts,
      value: health.prompts === 0 ? 0 : longPrompts / health.prompts,
      threshold: INSIGHT_MIN_SHARE,
      tip: "Split the work into smaller prompts.",
    },
  ];
  return candidates
    .filter((insight) => insight.base > 0 && insight.share >= INSIGHT_MIN_SHARE)
    .sort((a, b) => b.share - a.share || compare(a.id, b.id))
    .slice(0, INSIGHT_MAX);
}

export type BehaviourUsageReport = Pick<UsageReport, "surfaces" | "tools" | "health" | "windows" | "insights">;

/** The behaviour parts of the report: surfaces, tools, agent health, five-hour windows and insights. Pure, like buildCoreReport. */
export function buildBehaviourReport(facts: readonly FileUsageFacts[], query: UsageQuery, prices: PriceTable, now: number): BehaviourUsageReport {
  const scope = scopeOf(facts, query, prices, now);
  const rows = rangeRowsOf(scope);
  const tools = toolsOf(rows);
  const health = healthOf(rows);
  return {
    surfaces: surfacesOf(rows, scope.priceOf),
    tools,
    health,
    windows: windowsOf(rows, scope.priceOf, now),
    insights: insightsOf(rows, scope.priceOf, health, tools),
  };
}

export function buildReport(facts: readonly FileUsageFacts[], query: UsageQuery, prices: PriceTable, now: number, files: number): UsageReport {
  return { ...buildCoreReport(facts, query, prices, now, files), ...buildBehaviourReport(facts, query, prices, now) };
}
