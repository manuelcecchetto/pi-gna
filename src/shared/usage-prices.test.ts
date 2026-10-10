import { describe, expect, it } from "vitest";
import type { PriceEntry, PriceTable } from "./usage";
import { costOf, findPrice, priceIndex } from "./usage-prices";

const rates = (input: number) => ({ input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25 });

const tiered: PriceEntry = {
  provider: "acme",
  model: "big",
  rates: rates(1),
  tiers: [
    { inputTokensAbove: 100_000, rates: rates(2) },
    { inputTokensAbove: 200_000, rates: rates(3) },
    { inputTokensAbove: 272_000, rates: rates(4) },
  ],
};

const turn = (input: number, cacheRead = 0, cacheWrite = 0) => ({ input, output: 0, cacheRead, cacheWrite });

describe("costOf", () => {
  it("prices a turn at the highest tier its input exceeds, and the whole turn at that tier's rates", () => {
    expect(costOf(turn(90_000), tiered)).toBeCloseTo(90_000 * 1 / 1e6, 12);
    expect(costOf(turn(150_000), tiered)).toBeCloseTo(150_000 * 2 / 1e6, 12);
    expect(costOf(turn(250_000), tiered)).toBeCloseTo(250_000 * 3 / 1e6, 12);
    expect(costOf(turn(300_000), tiered)).toBeCloseTo(300_000 * 4 / 1e6, 12);
  });

  it("does not move up a tier at exactly the edge", () => {
    expect(costOf(turn(100_000), tiered)).toBeCloseTo(100_000 * 1 / 1e6, 12);
    expect(costOf(turn(200_000), tiered)).toBeCloseTo(200_000 * 2 / 1e6, 12);
    expect(costOf(turn(272_000), tiered)).toBeCloseTo(272_000 * 3 / 1e6, 12);
    expect(costOf(turn(272_001), tiered)).toBeCloseTo(272_001 * 4 / 1e6, 12);
  });

  it("counts cache reads and writes toward the tier", () => {
    const usage = { input: 10, output: 1_000, cacheRead: 150_000, cacheWrite: 60_000 };
    expect(costOf(usage, tiered)).toBeCloseTo((10 * 3 + 1_000 * 15 + 150_000 * 0.3 + 60_000 * 3.75) / 1e6, 12);
  });

  it("prices a model without tiers at its base rates", () => {
    const flat: PriceEntry = { provider: "acme", model: "small", rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, tiers: [] };
    expect(costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, flat)).toBeCloseTo(29.2, 12);
  });
});

const table: PriceTable = {
  source: "test",
  asOf: "",
  entries: [
    { provider: "anthropic", model: "claude-opus-5-5", rates: rates(4), tiers: [] },
    { provider: "zai", model: "glm-5.2", rates: rates(1.4), tiers: [] },
    { provider: "openrouter", model: "glm-5.2", rates: rates(9), tiers: [] },
    { provider: "claude-bridge", model: "claude-sonnet-5-5", rates: rates(7), tiers: [] },
    { provider: "anthropic", model: "claude-sonnet-5-5", rates: rates(2), tiers: [] },
  ],
};

describe("findPrice", () => {
  const index = priceIndex(table);

  it("finds the exact provider and model first", () => {
    expect(findPrice(index, "zai", "glm-5.2")?.provider).toBe("zai");
  });

  it("uses the alias when the exact provider has no such model", () => {
    expect(findPrice(index, "claude-bridge", "claude-opus-5-5")?.provider).toBe("anthropic");
  });

  it("prefers an exact entry over the alias", () => {
    expect(findPrice(index, "claude-bridge", "claude-sonnet-5-5")?.provider).toBe("claude-bridge");
  });

  it("falls back to the model id under any provider", () => {
    expect(findPrice(index, "dynamic3_3090", "glm-5.2")?.provider).toBe("zai");
  });

  it("leaves a model with no price unpriced", () => {
    expect(findPrice(index, "claude-bridge", "claude-haiku-5-5")).toBeUndefined();
    expect(findPrice(index, "unknown", "no-such-model")).toBeUndefined();
  });
});
