// The real side of scripts/usage-crosscheck.mjs: the production index and report over the snapshot the naive reader used.
// Skipped unless USAGE_CROSSCHECK_WORK names that work directory (it holds snap/ and naive.json from the naive pass).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport } from "../src/shared/usage-report";
import { loadPriceTable } from "../src/main/usage-pricing";
import { extractFileUsage } from "../src/main/usage-extract";
import { UsageIndex } from "../src/main/usage-index";

const work = process.env.USAGE_CROSSCHECK_WORK;

const openExtractor = () => ({ extract: extractFileUsage, close: async () => {} });

function factSums(facts) {
  const perModel = {};
  let turns = 0;
  let toolCalls = 0;
  let prompts = 0;
  let skippedLines = 0;
  let skippedEntries = 0;
  for (const fact of facts) {
    prompts += fact.prompts.count;
    skippedLines += fact.skipped.lines;
    skippedEntries += fact.skipped.entries;
    for (const tool of Object.values(fact.tools)) toolCalls += tool.calls;
    for (const bucket of fact.buckets) {
      turns += bucket.turns;
      const key = `${bucket.provider}/${bucket.model}`;
      const m = (perModel[key] ??= { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, recorded: 0 });
      m.turns += bucket.turns;
      m.recorded += bucket.recordedCost;
      for (const k of Object.keys(m.tokens)) m.tokens[k] += bucket.tokens[k];
    }
  }
  return { files: facts.length, turns, toolCalls, prompts, skippedLines, skippedEntries, perModel };
}

describe.skipIf(!work)("usage cross-check (real index and report)", () => {
  it("indexes the snapshot cold and warm, then builds the reports", async () => {
    const naive = JSON.parse(readFileSync(join(work, "naive.json"), "utf8"));
    const roots = { sessions: join(work, "snap", "sessions"), atp: join(work, "snap", "atp") };
    const file = join(work, "usage-index.json");
    rmSync(file, { force: true });
    const concurrency = 4;

    const cold = new UsageIndex({ roots: () => roots, file, openExtractor, concurrency });
    const t0 = performance.now();
    await cold.ensureIndexed();
    const coldMs = Math.round(performance.now() - t0);
    const coldFacts = cold.allFacts();
    const discovered = cold.discovered();

    const warm = new UsageIndex({ roots: () => roots, file, openExtractor, concurrency });
    const t1 = performance.now();
    await warm.ensureIndexed();
    const warmMs = Math.round(performance.now() - t1);
    const warmFacts = warm.allFacts();
    const warmSame = JSON.stringify(coldFacts) === JSON.stringify(warmFacts);

    const prices = loadPriceTable();
    const query = { range: `${naive.days}d`, source: "all", timeZone: naive.timeZone };
    const t2 = performance.now();
    const report = buildReport(coldFacts, query, prices, naive.now, discovered);
    const reportMs = Math.round(performance.now() - t2);
    const history = buildReport(coldFacts, { range: "all", source: "all", timeZone: naive.timeZone }, prices, naive.now, discovered);
    const pigna = buildReport(coldFacts, { range: `${naive.days}d`, source: "pigna", timeZone: naive.timeZone }, prices, naive.now, discovered);

    const priceOpus = prices.entries.filter((e) => e.model === "claude-opus-5-5").map((e) => ({ provider: e.provider, rates: e.rates, tiers: e.tiers }));
    writeFileSync(
      join(work, "real.json"),
      JSON.stringify({ coldMs, warmMs, warmSame, reportMs, discovered, factSums: factSums(coldFacts), priceOpus, report, history, pigna }, null, 2),
    );
    expect(warmSame).toBe(true);
    expect(report.meta.from).toBe(naive.period.from);
    expect(report.meta.to).toBe(naive.period.to);
  }, 900_000);
});
