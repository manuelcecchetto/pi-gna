import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarFrame,
  chartColor,
  colorScale,
  colorSlot,
  dayOffset,
  everyNth,
  formatShare,
  heatFill,
  heatLevel,
  niceTicks,
  weekdayIndex,
} from "./chart-scale";

describe("niceTicks", () => {
  it("rounds the top up to a step of 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceTicks(100, 4)).toEqual({ max: 100, step: 25, ticks: [0, 25, 50, 75, 100] });
    expect(niceTicks(7_340, 4)).toEqual({ max: 8000, step: 2000, ticks: [0, 2000, 4000, 6000, 8000] });
    expect(niceTicks(0.37, 4)).toEqual({ max: 0.4, step: 0.1, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
  });

  it("falls back to 0 to 1 when there is nothing to scale", () => {
    expect(niceTicks(0)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
    expect(niceTicks(Number.NaN)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
  });
});

describe("colour slots", () => {
  it("gives a key the same slot every time and always inside the palette", () => {
    const keys = Array.from({ length: 40 }, (_, index) => `provider/model-${index}`);
    const first = keys.map(colorSlot);
    expect(keys.map(colorSlot)).toEqual(first);
    expect(first.every((slot) => slot >= 0 && slot < 8)).toBe(true);
    expect(new Set(first).size).toBeGreaterThanOrEqual(6);
  });

  it("gives the keys of one chart distinct colours, whatever their order", () => {
    const models = ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-5.5", "anthropic/claude-haiku-4-5", "openai-codex/gpt-6-astra"];
    const color = colorScale(models);
    expect(new Set(models.map(color)).size).toBe(models.length);
    expect(models.map(colorScale([...models].reverse()))).toEqual(models.map(color));
    const eight = Array.from({ length: 8 }, (_, index) => `model-${index}`);
    expect(new Set(eight.map(colorScale(eight))).size).toBe(8);
  });

  it("maps slots onto the theme's chart variables, wrapping around", () => {
    expect(chartColor(0)).toBe("var(--chart-1)");
    expect(chartColor(7)).toBe("var(--chart-8)");
    expect(chartColor(9)).toBe("var(--chart-2)");
  });
});

describe("heat levels", () => {
  it("leaves empty and unscaled cells at level 0 and caps the top at the last level", () => {
    expect([heatLevel(0, 10), heatLevel(5, 0), heatLevel(-1, 10)]).toEqual([0, 0, 0]);
    expect([heatLevel(0.1, 10), heatLevel(2.5, 10), heatLevel(10, 10), heatLevel(25, 10)]).toEqual([1, 2, 4, 4]);
  });

  it("paints empty cells with the foreground tint and levels with the accent", () => {
    expect(heatFill(0)).toContain("var(--fg)");
    expect(heatFill(3)).toContain("var(--accent)");
  });
});

describe("calendar frames", () => {
  it("starts on the Monday of the first day's week", () => {
    expect(weekdayIndex("2026-10-10")).toBe(5);
    expect(calendarFrame("2026-10-07", "2026-10-10")).toEqual({ start: "2026-10-05", weeks: 1 });
    expect(calendarFrame("2026-09-28", "2026-10-11")).toEqual({ start: "2026-09-28", weeks: 2 });
  });

  it("counts days across month and year boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(dayOffset("2026-02-27", "2026-03-01")).toBe(2);
  });
});

describe("labels and shares", () => {
  it("shows every nth label so that about `fit` labels remain", () => {
    expect([everyNth(30, 10), everyNth(5, 10), everyNth(0, 4)]).toEqual([3, 1, 1]);
  });

  it("formats shares, with a floor for the tiny ones", () => {
    expect([formatShare(0), formatShare(0.004), formatShare(0.456), formatShare(1)]).toEqual(["0%", "<1%", "46%", "100%"]);
  });
});
