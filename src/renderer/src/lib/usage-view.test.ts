import { describe, expect, it } from "vitest";
import {
  CONTEXT_EDGES,
  ERROR_CATEGORIES,
  INSIGHT_IDS,
  type Insight,
  type ModelRow,
  STEP_EDGES,
  STOP_REASONS,
  SURFACES,
  type Surface,
  type SurfaceRow,
  type ToolRow,
  type UsageDay,
  type WeekHour,
} from "../../../shared/usage";
import {
  billedTokens,
  CALENDAR_DAYS,
  calendarValues,
  CONTEXT_BIN_LABELS,
  ERROR_LABELS,
  HOUR_LABELS,
  hoursOf,
  INSIGHT_LABELS,
  insightFigures,
  labelledCounts,
  MODEL_SERIES_MAX,
  modelDayBars,
  percentOf,
  STEP_BIN_LABELS,
  STOP_LABELS,
  SURFACE_LABELS,
  surfaceParts,
  TOOL_BARS_MAX,
  toolBars,
  toolSummary,
  plural,
  sortModels,
  turnDayBars,
  usd,
  weekHourRows,
} from "./usage-view";

const day = (date: string, models: [string, number, number][], turns = 0): UsageDay => ({
  day: date,
  turns,
  tokens: models.reduce((total, [, tokens]) => total + tokens, 0),
  estimated: models.reduce((total, [, , cost]) => total + cost, 0),
  models: models.map(([key, tokens, estimated]) => ({ key, tokens, estimated })),
});

const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 99 };

describe("usage view", () => {
  it("bills input, output and both cache types, never reasoning (it sits inside output)", () => {
    expect(billedTokens(tokens)).toBe(10);
  });

  it("formats money with a floor and percentages with one decimal", () => {
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(0)).toMatch(/0\.00/);
    expect(usd(2824.1)).toMatch(/2,?824/);
    expect(percentOf(0.9764)).toBe("97.6%");
    expect(hoursOf(5_400_000)).toBe("1.5 h");
  });

  it("stacks each day's models and folds the smallest into Other models", () => {
    const names = Array.from({ length: MODEL_SERIES_MAX + 2 }, (_, index) => `p/m${index}`);
    const days = [day("2026-10-01", names.map((key, index) => [key, 10 * (index + 1), index + 1]))];
    const { series, buckets } = modelDayBars(days, "tokens");
    expect(series.map((item) => item.key)).toEqual([...names.slice(-MODEL_SERIES_MAX).reverse(), "other"]);
    expect(series.at(-1)?.label).toBe("Other models");
    const values = buckets[0]!.values;
    expect(values.other).toBe(10 + 20);
    expect(Object.values(values).reduce((total, value) => total + value, 0)).toBe(names.reduce((total, _, index) => total + 10 * (index + 1), 0));
  });

  it("drops models with nothing to show for the measure", () => {
    const days = [day("2026-10-01", [["p/free", 500, 0], ["p/paid", 100, 2]])];
    expect(modelDayBars(days, "cost").series.map((item) => item.key)).toEqual(["p/paid"]);
    expect(modelDayBars(days, "tokens").series.map((item) => item.key)).toEqual(["p/free", "p/paid"]);
  });

  it("keeps empty days as zero bars and labels them", () => {
    const days = [day("2026-10-01", [], 0), day("2026-10-02", [["p/a", 5, 1]], 3)];
    expect(turnDayBars(days).buckets.map((bucket) => bucket.values.turns)).toEqual([0, 3]);
    expect(modelDayBars(days, "cost").buckets[0]!.values).toEqual({});
  });

  it("shows the last 26 weeks of a longer range in the calendar", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    const days = Array.from({ length: 200 }, (_, index) => day(new Date(start + index * 86_400_000).toISOString().slice(0, 10), [], 0));
    const values = calendarValues(days, "tokens");
    expect(values).toHaveLength(CALENDAR_DAYS);
    expect(values[0]?.date).toBe(days[200 - CALENDAR_DAYS]!.day);
    expect(values.at(-1)?.date).toBe("2026-07-19");
  });

  it("uses the cost or the tokens of each calendar day", () => {
    const days = [day("2026-10-01", [["p/a", 7, 0.5]])];
    expect(calendarValues(days, "cost")).toEqual([{ date: "2026-10-01", value: 0.5 }]);
    expect(calendarValues(days, "tokens")).toEqual([{ date: "2026-10-01", value: 7 }]);
  });

  it("cuts the weekday by hour cells into Monday-first rows of 24", () => {
    const cells = (offset: number) => Array.from({ length: 168 }, (_, index) => index + offset);
    const week: WeekHour = { turns: cells(0), tokens: cells(1000), estimated: cells(2000) };
    const rows = weekHourRows(week, "tokens");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveLength(24);
    expect(rows[6]![23]).toBe(1000 + 167);
    expect(weekHourRows(week, "cost")[1]![0]).toBe(2024);
    expect(HOUR_LABELS).toHaveLength(24);
    expect(HOUR_LABELS[7]).toBe("07");
  });
});

const tool = (name: string, calls: number, errors: number, avgMs: number | null): ToolRow => ({
  name,
  calls,
  errors,
  errorRate: calls === 0 ? 0 : errors / calls,
  avgMs,
  nestedCalls: 0,
});

describe("usage panels", () => {
  it("labels every surface, stop reason, error category and insight rule", () => {
    expect(Object.keys(SURFACE_LABELS).sort()).toEqual([...SURFACES].sort());
    expect(Object.keys(STOP_LABELS).sort()).toEqual([...STOP_REASONS].sort());
    expect(Object.keys(ERROR_LABELS).sort()).toEqual([...ERROR_CATEGORIES].sort());
    expect(Object.keys(INSIGHT_LABELS).sort()).toEqual([...INSIGHT_IDS].sort());
  });

  it("has one histogram label per bin binOf makes", () => {
    expect(STEP_BIN_LABELS).toHaveLength(STEP_EDGES.length + 1);
    expect(CONTEXT_BIN_LABELS).toHaveLength(CONTEXT_EDGES.length + 1);
  });

  it("splits the surfaces that have usage, by tokens or by cost", () => {
    const row = (surface: Surface, tokens: number, estimated: number): SurfaceRow => ({
      surface,
      sessions: 0,
      turns: 0,
      tokens,
      estimated,
      subagentTokens: 0,
      subagentEstimated: 0,
    });
    const rows = [row("pigna-chat", 10, 0), row("card", 0, 0), row("ci", 0, 1.5)];
    expect(surfaceParts(rows, "tokens").map((part) => part.key)).toEqual(["pigna-chat"]);
    expect(surfaceParts(rows, "cost")).toEqual([{ key: "ci", label: "CI runners", value: 1.5 }]);
  });

  it("lists counted categories in label order and leaves out zeros", () => {
    expect(labelledCounts({ error: 2, toolUse: 0, stop: 5 }, STOP_LABELS)).toEqual([
      { key: "stop", label: "Finished", value: 5 },
      { key: "error", label: "Error", value: 2 },
    ]);
  });

  it("gives each tool's failure rate and mean duration, or none when untimed", () => {
    expect(toolSummary(tool("bash", 100, 2, 9300))).toBe("2.0% failed · 9.3s avg");
    expect(toolSummary(tool("read", 4, 0, null))).toBe("0.0% failed · no timing");
  });

  it("singularises a count of one", () => {
    expect(plural(1, "turn")).toBe("1 turn");
    expect(plural(2, "turn")).toBe("2 turns");
  });

  it("gives bars to the most called tools only", () => {
    const rows = Array.from({ length: TOOL_BARS_MAX + 2 }, (_, index) => tool(`t${index}`, 100 - index, 0, null));
    expect(toolBars(rows)).toHaveLength(TOOL_BARS_MAX);
    expect(toolBars(rows)[0]).toEqual({ key: "t0", label: "t0", value: 100 });
  });

  it("states a compaction rule as prompts per compaction against its ceiling", () => {
    const insight: Insight = { id: "compactions", share: 0.25, count: 4, base: 40, value: 10, threshold: 10, tip: "" };
    expect(insightFigures(insight)).toEqual({ value: "10.0 prompts per compaction", threshold: "10 prompts or fewer", detail: "4 compactions in 40 prompts" });
  });

  it("states a share rule as a percentage of its base", () => {
    const insight: Insight = { id: "errors", share: 0.25, count: 30, base: 120, value: 0.25, threshold: 0.1, tip: "" };
    expect(insightFigures(insight)).toEqual({ value: "25.0% of turns", threshold: "10.0%", detail: "30 of 120 turns" });
  });
});

describe("sortModels", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const model = (provider: string, name: string, over: Partial<ModelRow>): ModelRow => ({
    provider,
    model: name,
    turns: 1,
    errorTurns: 0,
    tokens: zero,
    estimated: 0,
    recorded: 0,
    priced: true,
    share: 0,
    cacheHitRate: 0,
    ...over,
  });
  const rows = [
    model("anthropic", "sonnet", { turns: 5, tokens: { ...zero, input: 10, output: 1 }, estimated: 2, share: 0.5, cacheHitRate: 0.2 }),
    model("openai", "gpt", { turns: 9, tokens: { ...zero, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, estimated: 4, share: 0.25, cacheHitRate: 0.9 }),
    model("anthropic", "opus", { turns: 5, priced: false, share: 0.25, cacheHitRate: 0.2 }),
  ];
  const names = (sort: { key: Parameters<typeof sortModels>[1]["key"]; desc: boolean }) =>
    sortModels(rows, sort).map((row) => `${row.provider}/${row.model}`);

  it("sorts by estimated cost, tokens, turns, share and cache hit, both ways", () => {
    expect(names({ key: "estimated", desc: true })).toEqual(["openai/gpt", "anthropic/sonnet", "anthropic/opus"]);
    expect(names({ key: "estimated", desc: false })).toEqual(["anthropic/opus", "anthropic/sonnet", "openai/gpt"]);
    expect(names({ key: "tokens", desc: true })).toEqual(["anthropic/sonnet", "openai/gpt", "anthropic/opus"]);
    expect(names({ key: "tokens", desc: false })).toEqual(["anthropic/opus", "openai/gpt", "anthropic/sonnet"]);
    expect(names({ key: "turns", desc: true })).toEqual(["openai/gpt", "anthropic/opus", "anthropic/sonnet"]);
    expect(names({ key: "share", desc: true })).toEqual(["anthropic/sonnet", "anthropic/opus", "openai/gpt"]);
    expect(names({ key: "cacheHitRate", desc: false })).toEqual(["anthropic/opus", "anthropic/sonnet", "openai/gpt"]);
  });

  it("sorts the model column by name, A to Z or Z to A", () => {
    expect(names({ key: "model", desc: false })).toEqual(["anthropic/opus", "anthropic/sonnet", "openai/gpt"]);
    expect(names({ key: "model", desc: true })).toEqual(["openai/gpt", "anthropic/sonnet", "anthropic/opus"]);
  });
});

