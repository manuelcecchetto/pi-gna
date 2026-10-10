import { describe, expect, it } from "vitest";
import {
  type FileUsageFacts,
  type PriceTable,
  type SessionMeta,
  type TokenCounts,
  type UsageBucket,
  type UsageQuery,
  USAGE_FACTS_VERSION,
} from "./usage";
import { buildCoreReport } from "./usage-report";

const HOUR = 3_600_000;
const hourOf = (iso: string) => Date.parse(iso) / HOUR;
const tokens = (t: Partial<TokenCounts> = {}): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...t });

function bucket(
  iso: string,
  provider: string,
  model: string,
  t: Partial<TokenCounts> = {},
  extra: Partial<Pick<UsageBucket, "turns" | "errorTurns" | "recordedCost">> & { tierTokens?: Partial<TokenCounts> } = {},
): UsageBucket {
  return {
    hour: hourOf(iso),
    provider,
    model,
    turns: extra.turns ?? 1,
    errorTurns: extra.errorTurns ?? 0,
    missTurns: 0,
    recordedCost: extra.recordedCost ?? 0,
    tokens: tokens(t),
    tierTokens: tokens(extra.tierTokens),
  };
}

function file(session: Partial<SessionMeta>, buckets: UsageBucket[], extra: Partial<FileUsageFacts> = {}): FileUsageFacts {
  const prompts = { count: 0, aborted: 0, steps: 0, toolCalls: 0, wallMs: 0, stepHist: [] };
  return {
    version: USAGE_FACTS_VERSION,
    size: 0,
    mtimeMs: 0,
    consumedBytes: 0,
    session: {
      id: "s1",
      root: "sessions",
      path: "/sessions/s1.jsonl",
      surface: "pigna-chat",
      pigna: true,
      cwd: "/work/app",
      project: "/work/app",
      firstAt: 0,
      lastAt: 0,
      activeMs: 0,
      ...session,
    },
    markers: { systemMessage: true, pignaTools: true, atpRuntime: false },
    buckets,
    tools: {},
    stops: {},
    errors: {},
    contextHist: [],
    thinking: {},
    prompts,
    compactions: 0,
    compactedTokens: 0,
    contextEdits: 0,
    subagentRuns: {},
    skipped: { lines: 0, entries: 0 },
    resume: { pending: {}, closed: prompts },
    ...extra,
  };
}

const prices: PriceTable = {
  source: "test",
  asOf: "2026-01-01T00:00:00Z",
  entries: [
    { provider: "anthropic", model: "sonnet", rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, tiers: [] },
    {
      provider: "acme",
      model: "big",
      rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      tiers: [{ inputTokensAbove: 272_000, rates: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } }],
    },
  ],
};

const NOW = Date.parse("2026-01-15T12:00:00Z");
const query = (over: Partial<UsageQuery> = {}): UsageQuery => ({ range: "30d", source: "pigna", timeZone: "UTC", ...over });
const build = (facts: FileUsageFacts[], over: Partial<UsageQuery> = {}, now = NOW) =>
  buildCoreReport(facts, query(over), prices, now, facts.length);

describe("buildCoreReport calendar", () => {
  it("cuts days, weekdays and hours in the query's zone", () => {
    const facts = [file({}, [bucket("2026-01-14T03:00:00Z", "anthropic", "sonnet", { input: 10 })])];
    const report = build(facts, { timeZone: "America/New_York" });
    expect(report.days.find((day) => day.turns > 0)?.day).toBe("2026-01-13");
    const tuesday22 = 1 * 24 + 22;
    expect(report.weekHour.turns[tuesday22]).toBe(1);
  });

  it("keeps the local hours of a spring-forward day: there is no 02:00", () => {
    const facts = [
      file({}, [
        bucket("2026-03-08T05:00:00Z", "anthropic", "sonnet", { input: 1 }),
        bucket("2026-03-08T06:00:00Z", "anthropic", "sonnet", { input: 1 }),
        bucket("2026-03-08T07:00:00Z", "anthropic", "sonnet", { input: 1 }),
      ]),
    ];
    const report = build(facts, { timeZone: "America/New_York", range: { from: Date.parse("2026-03-07T05:00:00Z"), to: Date.parse("2026-03-09T04:00:00Z") } });
    const sunday = 6 * 24;
    expect([report.weekHour.turns[sunday], report.weekHour.turns[sunday + 1], report.weekHour.turns[sunday + 2], report.weekHour.turns[sunday + 3]]).toEqual([1, 1, 0, 1]);
    expect(report.days.map((day) => [day.day, day.turns])).toEqual([
      ["2026-03-07", 0],
      ["2026-03-08", 3],
    ]);
  });

  it("merges the repeated 01:00 of a fall-back day into one weekday-hour cell", () => {
    const facts = [
      file({}, [
        bucket("2026-11-01T05:00:00Z", "anthropic", "sonnet", { input: 1 }),
        bucket("2026-11-01T06:00:00Z", "anthropic", "sonnet", { input: 1 }),
      ]),
    ];
    const report = build(facts, { timeZone: "America/New_York", range: { from: Date.parse("2026-11-01T04:00:00Z"), to: Date.parse("2026-11-02T05:00:00Z") } });
    expect(report.weekHour.turns[6 * 24 + 1]).toBe(2);
    expect(report.days.find((day) => day.day === "2026-11-01")?.turns).toBe(2);
  });

  it("cuts the 7d range at local midnight, ending at now", () => {
    const report = build([], { range: "7d", timeZone: "America/New_York" });
    expect(report.meta.from).toBe(Date.parse("2026-01-09T05:00:00Z"));
    expect(report.days.map((day) => day.day)).toEqual([
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
    ]);
  });
});

describe("buildCoreReport filters", () => {
  const facts = [
    file({ id: "chat", pigna: true, project: "/work/app" }, [bucket("2026-01-14T10:00:00Z", "anthropic", "sonnet", { input: 100 })]),
    file({ id: "term", pigna: false, surface: "terminal", project: "/work/other" }, [bucket("2026-01-14T11:00:00Z", "anthropic", "sonnet", { input: 300 })]),
    file({ id: "old", pigna: true }, [bucket("2025-06-01T10:00:00Z", "anthropic", "sonnet", { input: 999 })]),
  ];

  it("keeps only pi-gna's surfaces for the pigna source, and every session for all", () => {
    expect(build(facts, { range: "all" }).totals.sessions).toBe(2);
    expect(build(facts, { range: "all", source: "all" }).totals.sessions).toBe(3);
    expect(build(facts, { range: "all", source: "all" }).totals.tokens.input).toBe(1399);
  });

  it("filters by project", () => {
    const report = build(facts, { range: "all", source: "all", project: "/work/other" });
    expect(report.totals.tokens.input).toBe(300);
    expect(report.projects.map((row) => row.project)).toEqual(["/work/other"]);
  });

  it("counts a file by its turns in the range, not by its whole span", () => {
    const report = build(facts, { range: { from: Date.parse("2026-01-14T00:00:00Z"), to: Date.parse("2026-01-15T00:00:00Z") } });
    expect(report.totals.tokens.input).toBe(100);
    expect(report.meta.from).toBe(Date.parse("2026-01-14T00:00:00Z"));
  });
});

describe("buildCoreReport cost", () => {
  it("keeps estimated and recorded cost apart, and shows unpriced usage", () => {
    const facts = [
      file({ id: "a" }, [bucket("2026-01-14T10:00:00Z", "anthropic", "sonnet", { input: 1_000_000 }, { recordedCost: 0.5 })]),
      file({ id: "b" }, [bucket("2026-01-14T11:00:00Z", "mystery", "model", { input: 1_000_000 }, { recordedCost: 0.25 })]),
    ];
    const report = build(facts, { range: "all" });
    expect(report.totals.cost).toEqual({ estimated: 1, recorded: 0.75, unpricedTurns: 1, unpricedShare: 0.5 });
    const mystery = report.models.find((row) => row.model === "model");
    expect(mystery).toMatchObject({ priced: false, estimated: 0, share: 0.5 });
    expect(report.models[0]).toMatchObject({ model: "sonnet", priced: true, estimated: 1, share: 0.5 });
  });

  it("prices the part of a turn above the tier edge at the tier's rates", () => {
    const facts = [
      file({}, [bucket("2026-01-14T10:00:00Z", "acme", "big", { input: 350_000 }, { tierTokens: { input: 300_000 } })]),
    ];
    const report = build(facts, { range: "all" });
    expect(report.totals.cost.estimated).toBeCloseTo(50_000 * 2 / 1e6 + 300_000 * 4 / 1e6, 12);
  });

  it("computes cache hit rate over input, cache read and cache write", () => {
    const facts = [file({}, [bucket("2026-01-14T10:00:00Z", "anthropic", "sonnet", { input: 100, cacheRead: 300, cacheWrite: 100 })])];
    const report = build(facts, { range: "all" });
    expect(report.totals.cacheHitRate).toBeCloseTo(0.6, 12);
    expect(report.models[0]?.cacheHitRate).toBeCloseTo(0.6, 12);
  });
});

describe("buildCoreReport streaks", () => {
  const facts = [
    file({}, [
      bucket("2026-01-01T10:00:00Z", "anthropic", "sonnet", { input: 1 }),
      bucket("2026-01-02T10:00:00Z", "anthropic", "sonnet", { input: 1 }),
      bucket("2026-01-03T10:00:00Z", "anthropic", "sonnet", { input: 1 }),
      bucket("2026-01-04T10:00:00Z", "anthropic", "sonnet", { input: 1 }),
      bucket("2026-01-06T10:00:00Z", "anthropic", "sonnet", { input: 1 }),
      bucket("2026-01-07T10:00:00Z", "anthropic", "sonnet", { input: 1 }),
    ]),
  ];
  const range = (to: string) => ({ range: { from: Date.parse("2026-01-01T00:00:00Z"), to: Date.parse(to) } });

  it("finds the longest run and the current run ending on the last day", () => {
    const report = build(facts, range("2026-01-08T00:00:00Z"));
    expect(report.totals.longestStreak).toBe(4);
    expect(report.totals.currentStreak).toBe(2);
    expect(report.days).toHaveLength(7);
  });

  it("does not break the current streak while the last day has no turns yet", () => {
    const report = build(facts, range("2026-01-09T00:00:00Z"));
    expect(report.days.at(-1)?.turns).toBe(0);
    expect(report.totals.currentStreak).toBe(2);
    expect(report.totals.longestStreak).toBe(4);
  });
});

describe("buildCoreReport tables", () => {
  it("orders models by estimate, then tokens, then name, and reports each share", () => {
    const facts = [
      file({ id: "a" }, [
        bucket("2026-01-14T10:00:00Z", "anthropic", "sonnet", { input: 2_000_000 }),
        bucket("2026-01-14T11:00:00Z", "mystery", "zzz", { input: 4_000_000 }),
        bucket("2026-01-14T12:00:00Z", "mystery", "aaa", { input: 4_000_000 }),
      ]),
    ];
    const report = build(facts, { range: "all" });
    expect(report.models.map((row) => `${row.provider}/${row.model}`)).toEqual(["anthropic/sonnet", "mystery/aaa", "mystery/zzz"]);
    expect(report.totals.topModel).toBe("anthropic/sonnet");
    expect(report.models.map((row) => row.share)).toEqual([0.2, 0.4, 0.4]);
  });

  it("folds a subagent into its parent session and ranks sessions by estimate", () => {
    const facts = [
      file({ id: "parent", firstAt: 1, lastAt: 5, activeMs: 100 }, [bucket("2026-01-14T10:00:00Z", "anthropic", "sonnet", { input: 1_000_000 })], {
        prompts: { count: 2, aborted: 1, steps: 3, toolCalls: 0, wallMs: 0, stepHist: [] },
      }),
      file({ id: "child", parentId: "parent", surface: "subagent", firstAt: 2, lastAt: 9, activeMs: 50 }, [
        bucket("2026-01-14T11:00:00Z", "anthropic", "sonnet", { input: 1_000_000 }),
      ]),
      file({ id: "small" }, [bucket("2026-01-14T12:00:00Z", "anthropic", "sonnet", { input: 1 })]),
    ];
    const report = build(facts, { range: "all" });
    expect(report.sessions.map((row) => row.id)).toEqual(["parent", "small"]);
    expect(report.sessions[0]).toMatchObject({ subagents: 1, turns: 2, estimated: 2, activeMs: 150, firstAt: 1, lastAt: 9, openable: true, prompts: 2 });
  });

  it("folds card worktrees into their project and labels the projects", () => {
    const facts = [
      file({ id: "chat", project: "/Users/me/app", card: undefined }, [bucket("2026-01-14T10:00:00Z", "anthropic", "sonnet", { input: 1 })]),
      file({ id: "card", project: "/Users/me/app", card: "a1b2c3", cwd: "/home/.pi-gna/worktrees/a1b2c3/Users/me/app", lastAt: 77 }, [
        bucket("2026-01-14T11:00:00Z", "anthropic", "sonnet", { input: 1 }),
      ]),
    ];
    const [row] = build(facts, { range: "all" }).projects;
    expect(row).toMatchObject({ project: "/Users/me/app", label: "app", sessions: 2, worktreeSessions: 1, turns: 2, lastAt: 77 });
  });
});

describe("buildCoreReport empty range", () => {
  it("returns zeros, empty tables and no days for an empty all-time range", () => {
    const report = build([], { range: "all" });
    expect(report.days).toEqual([]);
    expect(report.totals).toMatchObject({ turns: 0, sessions: 0, cacheHitRate: 0, topModel: null, currentStreak: 0, longestStreak: 0 });
    expect(report.totals.cost).toEqual({ estimated: 0, recorded: 0, unpricedTurns: 0, unpricedShare: 0 });
    expect(report.models).toEqual([]);
    expect(report.sessions).toEqual([]);
    expect(report.projects).toEqual([]);
    expect(report.weekHour.turns).toHaveLength(168);
  });

  it("returns one zero day per local day of a fixed range with no turns", () => {
    const report = build([], { range: "30d" });
    expect(report.days).toHaveLength(30);
    expect(report.days.every((day) => day.turns === 0 && day.models.length === 0)).toBe(true);
  });
});
