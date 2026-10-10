import { describe, expect, it } from "vitest";
import type { UsageDay, WeekHour } from "../../../shared/usage";
import { billedTokens, CALENDAR_DAYS, calendarValues, HOUR_LABELS, hoursOf, MODEL_SERIES_MAX, modelDayBars, percentOf, turnDayBars, usd, weekHourRows } from "./usage-view";

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
