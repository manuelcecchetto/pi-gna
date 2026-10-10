import { describe, expect, it } from "vitest";
import { loadUsageFilters, parseUsageFilters, saveUsageFilters, usageQueries, USAGE_DEFAULT_FILTERS } from "./usage-filters";

const memory = (initial?: string) => {
  const values = new Map<string, string>(initial === undefined ? [] : [["pigna:usage-filters", initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe("the Usage filters", () => {
  it("keeps valid saved filters and falls back per field", () => {
    expect(parseUsageFilters({ range: "90d", source: "all", project: "/Users/me/Code/app" })).toEqual({ range: "90d", source: "all", project: "/Users/me/Code/app" });
    expect(parseUsageFilters({ range: "1y", source: "everything", project: 3 })).toEqual(USAGE_DEFAULT_FILTERS);
    expect(parseUsageFilters(null)).toEqual(USAGE_DEFAULT_FILTERS);
  });

  it("drops a project the host would refuse", () => {
    expect(parseUsageFilters({ range: "all", source: "pigna", project: "" })).toEqual({ range: "all", source: "pigna" });
    expect(parseUsageFilters({ range: "all", source: "pigna", project: "x".repeat(1025) })).toEqual({ range: "all", source: "pigna" });
  });

  it("reads and writes the window's storage, and survives unreadable storage", () => {
    const storage = memory();
    saveUsageFilters({ range: "14d", source: "all", project: "/a" }, storage);
    expect(loadUsageFilters(storage)).toEqual({ range: "14d", source: "all", project: "/a" });
    expect(loadUsageFilters(memory("{not json"))).toEqual(USAGE_DEFAULT_FILTERS);
    expect(loadUsageFilters({ getItem: () => { throw new Error("denied"); } })).toEqual(USAGE_DEFAULT_FILTERS);
    expect(() => saveUsageFilters(USAGE_DEFAULT_FILTERS, { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });

  it("asks for the unscoped report, and the scoped one only with a project", () => {
    expect(usageQueries({ range: "30d", source: "pigna" }, "Europe/Paris")).toEqual({ base: { range: "30d", source: "pigna", timeZone: "Europe/Paris" } });
    expect(usageQueries({ range: "all", source: "all", project: "/a" }, "UTC")).toEqual({
      base: { range: "all", source: "all", timeZone: "UTC" },
      scoped: { range: "all", source: "all", timeZone: "UTC", project: "/a" },
    });
  });
});
