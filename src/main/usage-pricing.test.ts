import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "./log";
import { loadPriceTable, type PriceSources } from "./usage-pricing";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

const PRICE = (input: number) => ({ input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25 });

let root: string;
let sdk: string;
let agent: string;
let sources: PriceSources;

function write(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "usage-pricing-"));
  sdk = join(root, "pi-coding-agent");
  agent = join(root, "agent");
  write(join(sdk, "package.json"), { name: "@earendil-works/pi-coding-agent" });
  const ai = join(sdk, "node_modules", "@earendil-works", "pi-ai");
  write(join(ai, "package.json"), { name: "@earendil-works/pi-ai", version: "1.2.3" });
  const data = join(ai, "dist", "providers", "data");
  write(join(data, ".manifest.json"), { schemaVersion: 6, generatedAt: "2026-10-05T21:36:40.456Z", files: {} });
  write(join(data, "anthropic.json"), {
    "anthropic-messages": {
      "chat:claude-opus-5-5": { id: "claude-opus-5-5", provider: "anthropic", cost: PRICE(4) },
      "chat:claude-sonnet-5-5": { id: "claude-sonnet-5-5", provider: "anthropic", cost: PRICE(2) },
    },
  });
  write(join(data, "openai-codex.json"), {
    "openai-codex-responses": {
      "chat:gpt-5.5": {
        id: "gpt-5.5",
        provider: "openai-codex",
        cost: { ...PRICE(5), tiers: [{ inputTokensAbove: 272_000, ...PRICE(10) }] },
      },
    },
  });
  sources = { piSdk: () => sdk, agentDir: () => agent };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

const find = (table: ReturnType<typeof loadPriceTable>, provider: string, model: string) =>
  table.entries.find((entry) => entry.provider === provider && entry.model === model);

describe("loadPriceTable", () => {
  it("reads rates and tiers from pi-ai's data and names the pi-ai version", () => {
    const table = loadPriceTable(sources);
    expect(table.source).toBe("@earendil-works/pi-ai 1.2.3");
    expect(table.asOf).toBe("2026-10-05T21:36:40.456Z");
    expect(find(table, "anthropic", "claude-opus-5-5")).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      rates: PRICE(4),
      tiers: [],
    });
    expect(find(table, "openai-codex", "gpt-5.5")?.tiers).toEqual([{ inputTokensAbove: 272_000, rates: PRICE(10) }]);
  });

  it("reads a pi-ai package hoisted next to pi's package", () => {
    const hoisted = join(root, "node_modules", "@earendil-works");
    mkdirSync(hoisted, { recursive: true });
    const sibling = join(hoisted, "pi-coding-agent");
    write(join(sibling, "package.json"), { name: "@earendil-works/pi-coding-agent" });
    write(join(hoisted, "pi-ai", "dist", "providers", "data", "anthropic.json"), {
      "anthropic-messages": { "chat:claude-opus-5-5": { id: "claude-opus-5-5", provider: "anthropic", cost: PRICE(4) } },
    });
    expect(find(loadPriceTable({ piSdk: () => sibling, agentDir: () => agent }), "anthropic", "claude-opus-5-5")).toBeDefined();
  });

  it("gives an empty table when there is no pi install, without throwing", () => {
    expect(loadPriceTable({ piSdk: () => undefined, agentDir: () => agent })).toEqual({ source: "none", asOf: "", entries: [] });
  });

  it("gives an empty table when the pi folder has no pi-ai data", () => {
    const bare = join(root, "bare");
    write(join(bare, "package.json"), { name: "@earendil-works/pi-coding-agent" });
    expect(loadPriceTable({ piSdk: () => bare, agentDir: () => agent }).entries).toEqual([]);
  });

  it("applies models.json: a models entry replaces a model's cost, and modelOverrides merge field by field", () => {
    write(join(agent, "models.json"), {
      providers: {
        anthropic: {
          models: [
            {
              id: "claude-haiku-5-5",
              cost: { ...PRICE(0.1), tiers: [{ inputTokensAbove: 100_000, ...PRICE(0.5) }] },
            },
          ],
          modelOverrides: { "claude-opus-5-5": { cost: { cacheRead: 0.1 } } },
        },
        "openai-codex": {
          models: [{ id: "gpt-5.5", cost: PRICE(6) }],
        },
      },
    });
    const table = loadPriceTable(sources);
    expect(find(table, "anthropic", "claude-haiku-5-5")?.tiers).toEqual([{ inputTokensAbove: 100_000, rates: PRICE(0.5) }]);
    expect(find(table, "anthropic", "claude-opus-5-5")?.rates).toEqual({ ...PRICE(4), cacheRead: 0.1 });
    expect(find(table, "openai-codex", "gpt-5.5")).toEqual({ provider: "openai-codex", model: "gpt-5.5", rates: PRICE(6), tiers: [] });
  });

  it("ignores a models.json that is not valid JSON, with a warning, and keeps pi's table", () => {
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "models.json"), "{ not json");
    const table = loadPriceTable(sources);
    expect(find(table, "anthropic", "claude-opus-5-5")?.rates).toEqual(PRICE(4));
    expect(log.warn).toHaveBeenCalledWith("usage", expect.stringContaining("models.json"));
  });

  it("returns the cached table until pi-ai or models.json changes", () => {
    const first = loadPriceTable(sources);
    expect(loadPriceTable(sources)).toBe(first);
    write(join(agent, "models.json"), { providers: { anthropic: { modelOverrides: { "claude-opus-5-5": { cost: { input: 9 } } } } } });
    const second = loadPriceTable(sources);
    expect(second).not.toBe(first);
    expect(find(second, "anthropic", "claude-opus-5-5")?.rates.input).toBe(9);
  });
});
