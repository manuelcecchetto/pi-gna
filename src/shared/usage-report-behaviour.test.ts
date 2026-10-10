import { describe, expect, it } from "vitest";
import {
  type FileUsageFacts,
  type Insight,
  type PriceTable,
  type PromptStats,
  type SessionMeta,
  type TokenCounts,
  type ToolStat,
  type UsageBucket,
  type UsageQuery,
  type UsageReport,
  USAGE_FACTS_VERSION,
} from "./usage";
import { buildBehaviourReport, buildReport } from "./usage-report";

const HOUR = 3_600_000;
const hourAt = (iso: string) => Date.parse(iso) / HOUR;
const H0 = hourAt("2026-01-14T00:00:00Z");
const tokens = (t: Partial<TokenCounts> = {}): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...t });

function bucket(
  hour: number,
  provider: string,
  model: string,
  t: Partial<TokenCounts> = {},
  extra: { turns?: number; errorTurns?: number; tier?: Partial<TokenCounts> } = {},
): UsageBucket {
  return {
    hour,
    provider,
    model,
    turns: extra.turns ?? 1,
    errorTurns: extra.errorTurns ?? 0,
    missTurns: 0,
    recordedCost: 0,
    tokens: tokens(t),
    tierTokens: tokens(extra.tier),
  };
}

const emptyPrompts = (): PromptStats => ({ count: 0, aborted: 0, steps: 0, toolCalls: 0, wallMs: 0, stepHist: [] });

function file(session: Partial<SessionMeta>, buckets: UsageBucket[], extra: Partial<FileUsageFacts> = {}): FileUsageFacts {
  const prompts = emptyPrompts();
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

const tool = (over: Partial<ToolStat> = {}): ToolStat => ({ calls: 0, errors: 0, timedCalls: 0, durationMs: 0, nestedCalls: 0, ...over });

const prices: PriceTable = {
  source: "test",
  asOf: "2026-01-01T00:00:00Z",
  entries: [
    { provider: "anthropic", model: "sonnet", rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, tiers: [] },
    { provider: "anthropic", model: "opus", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, tiers: [] },
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
const behaviour = (facts: FileUsageFacts[], over: Partial<UsageQuery> = {}, now = NOW) => buildBehaviourReport(facts, query(over), prices, now);
const insightOf = (report: { insights: Insight[] }, id: Insight["id"]) => report.insights.find((insight) => insight.id === id);

describe("tools", () => {
  it("counts calls and errors per tool, most calls first, with error rate and mean duration", () => {
    const facts = [
      file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 10 })], {
        tools: {
          bash: tool({ calls: 4, errors: 2, timedCalls: 4, durationMs: 4000 }),
          read: tool({ calls: 10 }),
          codemode: tool({ calls: 1, errors: 1, timedCalls: 1, durationMs: 500, nestedCalls: 3 }),
        },
      }),
    ];
    const { tools } = behaviour(facts);
    expect(tools.rows.map((row) => [row.name, row.calls, row.errorRate, row.avgMs])).toEqual([
      ["read", 10, 0, null],
      ["bash", 4, 0.5, 1000],
      ["codemode", 1, 1, 500],
    ]);
    expect(tools.nestedCalls).toBe(3);
  });

  it("lists the top failing tools by errors, leaving out tools without errors", () => {
    const names = Array.from({ length: 7 }, (_, i) => `t${i}`);
    const toolsOf = Object.fromEntries(names.map((name, i) => [name, tool({ calls: 20, errors: i === 6 ? 0 : i + 1 })]));
    const { tools } = behaviour([file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], { tools: toolsOf })]);
    expect(tools.topFailing.map((row) => [row.name, row.errors])).toEqual([
      ["t5", 6],
      ["t4", 5],
      ["t3", 4],
      ["t2", 3],
      ["t1", 2],
    ]);
  });

  it("sums tool counts over the files in range only", () => {
    const facts = [
      file({ id: "in" }, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], { tools: { read: tool({ calls: 2 }) } }),
      file({ id: "out" }, [bucket(hourAt("2025-06-01T00:00:00Z"), "anthropic", "sonnet", { input: 1 })], { tools: { read: tool({ calls: 50 }) } }),
    ];
    expect(behaviour(facts).tools.rows).toEqual([expect.objectContaining({ name: "read", calls: 2 })]);
  });
});

describe("agent health", () => {
  it("sums stop reasons, error categories and context bins, and counts the sessions that compacted or edited", () => {
    const facts = [
      file({ id: "a" }, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], {
        stops: { error: 1, aborted: 2 },
        errors: { network: 3 },
        contextHist: [0, 0, 1, 0, 0, 0, 0, 0, 0],
        prompts: { count: 4, aborted: 1, steps: 12, toolCalls: 8, wallMs: 0, stepHist: [0, 1, 2, 1, 0, 0, 0] },
        compactions: 2,
        compactedTokens: 500,
        contextEdits: 1,
        subagentRuns: { completed: 2 },
      }),
      file({ id: "b" }, [bucket(H0 + 2, "anthropic", "sonnet", { input: 1 })], {
        stops: { error: 1 },
        contextHist: [0, 0, 0, 0, 0, 0, 1, 0, 0],
        prompts: { count: 6, aborted: 0, steps: 18, toolCalls: 12, wallMs: 0, stepHist: [0, 0, 0, 0, 0, 0, 0] },
        subagentRuns: { completed: 1, stopped: 1 },
      }),
    ];
    const { health } = behaviour(facts);
    expect(health.stops).toEqual({ error: 2, aborted: 2 });
    expect(health.errors).toEqual({ network: 3 });
    expect(health.contextHist).toEqual([0, 0, 1, 0, 0, 0, 1, 0, 0]);
    expect(health.promptSteps).toEqual([0, 1, 2, 1, 0, 0, 0]);
    expect(health.compactions).toBe(2);
    expect(health.compactedTokens).toBe(500);
    expect(health.compactingSessions).toBe(1);
    expect(health.editingSessions).toBe(1);
    expect(health.subagentRuns).toEqual({ completed: 3, stopped: 1 });
  });

  it("derives abort rate, steps and tool calls per prompt from the prompts in range", () => {
    const facts = [
      file({ id: "a" }, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], {
        prompts: { count: 4, aborted: 1, steps: 12, toolCalls: 8, wallMs: 0, stepHist: [] },
      }),
      file({ id: "b" }, [bucket(H0 + 2, "anthropic", "sonnet", { input: 1 })], {
        prompts: { count: 6, aborted: 0, steps: 18, toolCalls: 12, wallMs: 0, stepHist: [] },
      }),
    ];
    const { health } = behaviour(facts);
    expect(health.prompts).toBe(10);
    expect(health.abortRate).toBeCloseTo(0.1);
    expect(health.stepsPerPrompt).toBe(3);
    expect(health.toolCallsPerPrompt).toBe(2);
  });

  it("reports zero rates when there are no prompts", () => {
    const { health } = behaviour([file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })])]);
    expect([health.abortRate, health.stepsPerPrompt, health.toolCallsPerPrompt]).toEqual([0, 0, 0]);
  });
});

describe("surfaces", () => {
  const parent = file({ id: "p1", surface: "pigna-chat" }, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1_000_000 })]);
  const child = file({ id: "s1", surface: "subagent", parentId: "p1" }, [bucket(H0 + 2, "anthropic", "sonnet", { input: 2_000_000 })]);
  const orphan = file({ id: "o1", surface: "subagent", parentId: "missing" }, [bucket(H0 + 3, "anthropic", "sonnet", { input: 1_000_000 })]);

  it("rolls a subagent into its parent's surface and reports the subagent share", () => {
    const { surfaces } = behaviour([parent, child]);
    const chat = surfaces.find((row) => row.surface === "pigna-chat");
    expect(chat).toEqual({
      surface: "pigna-chat",
      sessions: 1,
      turns: 2,
      tokens: 3_000_000,
      estimated: 3,
      subagentTokens: 2_000_000,
      subagentEstimated: 2,
    });
  });

  it("keeps a subagent whose parent is out of scope as its own subagent surface", () => {
    const { surfaces } = behaviour([orphan]);
    expect(surfaces.find((row) => row.surface === "subagent")).toEqual({
      surface: "subagent",
      sessions: 1,
      turns: 1,
      tokens: 1_000_000,
      estimated: 1,
      subagentTokens: 0,
      subagentEstimated: 0,
    });
  });

  it("returns every surface in the fixed order, empty ones included", () => {
    const { surfaces } = behaviour([parent]);
    expect(surfaces.map((row) => row.surface)).toEqual(["pigna-chat", "card", "atp-worker", "subagent", "ci", "terminal"]);
    expect(surfaces.find((row) => row.surface === "ci")?.sessions).toBe(0);
  });
});

describe("five-hour windows", () => {
  it("starts a window at the first turn and keeps the hours before its end, then starts the next at the first hour after", () => {
    const facts = [
      file({}, [
        bucket(H0 + 1, "anthropic", "sonnet", { input: 1000 }),
        bucket(H0 + 5, "anthropic", "sonnet", { input: 1000 }),
        bucket(H0 + 6, "anthropic", "sonnet", { input: 500 }),
      ]),
    ];
    const { windows } = behaviour(facts);
    expect(windows.count).toBe(2);
    expect(windows.top.map((row) => [row.start, row.end, row.tokens, row.turns])).toEqual([
      [(H0 + 1) * HOUR, (H0 + 6) * HOUR, 2000, 2],
      [(H0 + 6) * HOUR, (H0 + 11) * HOUR, 500, 1],
    ]);
  });

  it("ranks the busiest windows by tokens and keeps at most five", () => {
    const facts = [file({}, Array.from({ length: 6 }, (_, i) => bucket(H0 + 6 * i, "anthropic", "sonnet", { input: (i + 1) * 1000 })))];
    const { windows } = behaviour(facts);
    expect(windows.count).toBe(6);
    expect(windows.top).toHaveLength(5);
    expect(windows.top.map((row) => row.tokens)).toEqual([6000, 5000, 4000, 3000, 2000]);
  });

  it("reports the window running now, with burn rate over its elapsed time", () => {
    const now = Date.parse("2026-01-14T03:30:00Z");
    const facts = [file({}, [bucket(H0, "anthropic", "sonnet", { input: 1000 }), bucket(H0 + 2, "anthropic", "sonnet", { input: 1000 })])];
    const { windows } = behaviour(facts, {}, now);
    expect(windows.current).toMatchObject({ start: H0 * HOUR, end: (H0 + 5) * HOUR, active: true, tokens: 2000 });
    expect(windows.current?.burnRate).toBeCloseTo(2000 / 210);
    expect(windows.top[0]?.active).toBe(true);
  });

  it("has no current window once the last window has ended", () => {
    const facts = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1000 })])];
    expect(behaviour(facts).windows.current).toBeNull();
  });
});

describe("insights", () => {
  it("fires at exactly the minimum share and not below it", () => {
    const at = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 }, { turns: 10, errorTurns: 1 })])];
    const below = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 }, { turns: 11, errorTurns: 1 })])];
    expect(insightOf(behaviour(at), "errors")).toMatchObject({ share: 0.1, count: 1, base: 10, threshold: 0.1 });
    expect(insightOf(behaviour(below), "errors")).toBeUndefined();
  });

  it("gives the share of cost from turns above the tier edge", () => {
    const facts = [file({}, [bucket(H0 + 1, "acme", "big", { input: 1_000_000 }, { tier: { input: 500_000 } })])];
    const insight = insightOf(behaviour(facts), "long-context");
    expect(insight?.share).toBeCloseTo(2 / 3);
    expect(insight?.base).toBeCloseTo(3);
  });

  it("does not flag long context when the turns above the edge are a small share of cost", () => {
    const facts = [
      file({}, [
        bucket(H0 + 1, "anthropic", "sonnet", { input: 90_000_000 }),
        bucket(H0 + 2, "acme", "big", { input: 1_000_000 }, { tier: { input: 1_000_000 } }),
      ]),
    ];
    expect(insightOf(behaviour(facts), "long-context")).toBeUndefined();
  });

  it("flags the cache-miss share: input and cache write against all input", () => {
    const facts = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 3000, cacheRead: 27_000, cacheWrite: 1000 })])];
    expect(insightOf(behaviour(facts), "cache-misses")).toMatchObject({ count: 4000, base: 31_000 });
    expect(insightOf(behaviour(facts), "cache-misses")?.share).toBeCloseTo(4 / 31);
  });

  it("flags the bash error rate from the bash tool's calls", () => {
    const facts = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], { tools: { bash: tool({ calls: 10, errors: 1 }) } })];
    expect(insightOf(behaviour(facts), "bash-errors")).toMatchObject({ share: 0.1, count: 1, base: 10, value: 0.1 });
  });

  it("flags a compaction every N prompts, with the prompts per compaction as its value", () => {
    const prompts = { count: 20, aborted: 0, steps: 0, toolCalls: 0, wallMs: 0, stepHist: [] };
    const fires = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], { prompts, compactions: 2 })];
    const quiet = [file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })], { prompts: { ...prompts, count: 21 }, compactions: 2 })];
    expect(insightOf(behaviour(fires), "compactions")).toMatchObject({ value: 10, threshold: 10, count: 2, base: 20 });
    expect(insightOf(behaviour(quiet), "compactions")).toBeUndefined();
  });

  it("flags subagents on an expensive model, and not subagents on a cheap one", () => {
    const parent = file({ id: "p1" }, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1_000_000 })]);
    const expensive = file({ id: "s1", parentId: "p1" }, [bucket(H0 + 2, "anthropic", "opus", { input: 1_000_000 })]);
    const cheap = file({ id: "s2", parentId: "p1" }, [bucket(H0 + 2, "anthropic", "sonnet", { input: 1_000_000 })]);
    expect(insightOf(behaviour([parent, expensive]), "expensive-subagents")).toMatchObject({ share: 1, count: 1, base: 5 });
    expect(insightOf(behaviour([parent, cheap]), "expensive-subagents")).toBeUndefined();
  });

  it("returns no insights for an empty range", () => {
    expect(behaviour([]).insights).toEqual([]);
  });

  it("keeps at most six insights, by share, then id", () => {
    const prompts = { count: 10, aborted: 5, steps: 0, toolCalls: 0, wallMs: 0, stepHist: [0, 0, 0, 0, 0, 0, 2] };
    const facts = [
      file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 20_000, output: 100, reasoning: 50 }, { turns: 10, errorTurns: 5 })], {
        prompts,
        compactions: 2,
        tools: { bash: tool({ calls: 10, errors: 5 }) },
      }),
    ];
    const { insights } = behaviour(facts);
    expect(insights.map((insight) => insight.id)).toEqual(["cache-misses", "aborts", "bash-errors", "errors", "reasoning", "compactions"]);
    expect(insights).toHaveLength(6);
  });
});

describe("buildReport", () => {
  it("joins the core parts with the behaviour parts", () => {
    const report: UsageReport = buildReport([file({}, [bucket(H0 + 1, "anthropic", "sonnet", { input: 1 })])], query(), prices, NOW, 1);
    expect(report.totals.turns).toBe(1);
    expect(report.windows.count).toBe(1);
    expect(report.surfaces).toHaveLength(6);
  });
});
