// The Usage page's filters, kept per window like the ATP panels (lib/layout.ts): a range, a source and a project.
import { USAGE_RANGES, type UsageQuery, type UsageRange, type UsageSource } from "../../../shared/usage";

export const USAGE_SOURCES = ["pigna", "all"] as const satisfies readonly UsageSource[];

export interface UsageFilters {
  range: UsageRange;
  source: UsageSource;
  /** A SessionMeta.project; none is every project. */
  project?: string;
}

export const USAGE_DEFAULT_FILTERS: UsageFilters = { range: "30d", source: "pigna" };

/** The host refuses a longer project path (parseUsageQuery). */
const PROJECT_MAX = 1024;
const KEY = "pigna:usage-filters";

/** The saved filters, each field checked; anything wrong falls back to the default for that field. */
export function parseUsageFilters(raw: unknown): UsageFilters {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const range = USAGE_RANGES.find((option) => option === saved.range) ?? USAGE_DEFAULT_FILTERS.range;
  const source = USAGE_SOURCES.find((option) => option === saved.source) ?? USAGE_DEFAULT_FILTERS.source;
  const project = typeof saved.project === "string" && saved.project !== "" && saved.project.length <= PROJECT_MAX ? saved.project : undefined;
  return project === undefined ? { range, source } : { range, source, project };
}

export function loadUsageFilters(storage: Pick<Storage, "getItem"> = localStorage): UsageFilters {
  try {
    return parseUsageFilters(JSON.parse(storage.getItem(KEY) ?? "null"));
  } catch {
    return { ...USAGE_DEFAULT_FILTERS };
  }
}

export function saveUsageFilters(filters: UsageFilters, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(filters));
  } catch {
    // storage unavailable: the filters just are not remembered
  }
}

/** The unscoped query (it lists the projects to pick from) and, with a project picked, the scoped one. */
export function usageQueries(filters: UsageFilters, timeZone: string): { base: UsageQuery; scoped?: UsageQuery } {
  const base: UsageQuery = { range: filters.range, source: filters.source, timeZone };
  return filters.project === undefined ? { base } : { base, scoped: { ...base, project: filters.project } };
}
