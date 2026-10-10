// List prices for Settings > Usage: pi-ai's table in pi's installed package, with the user's models.json applied the way
// pi applies it (a models entry replaces a model's cost, modelOverrides merge field by field). Read again when either
// file changes; nothing is fetched. Without a pi install the table is empty.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ModelRates, type PriceEntry, type PriceTable, type PriceTier } from "../shared/usage";
import { log } from "./log";
import { findPiSdk } from "./pi-auth";

const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const EMPTY: PriceTable = { source: "none", asOf: "", entries: [] };

export interface PriceSources {
  /** The folder of pi's package (@earendil-works/pi-coding-agent). */
  piSdk: () => string | undefined;
  agentDir: () => string;
}

const defaultSources: PriceSources = {
  piSdk: () => findPiSdk(process.env.PIGNA_PI_BIN || "pi"),
  agentDir: () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
};

let cache: { key: string; table: PriceTable } | undefined;

export function loadPriceTable(sources: PriceSources = defaultSources): PriceTable {
  const sdk = sources.piSdk();
  const piAi = sdk === undefined ? undefined : findPiAi(sdk);
  if (piAi === undefined) return EMPTY;
  const modelsFile = join(sources.agentDir(), "models.json");
  const data = join(piAi, "dist", "providers", "data");
  const key = [piAi, stamp(data), stamp(join(data, ".manifest.json")), stamp(modelsFile)].join("|");
  if (cache?.key !== key) cache = { key, table: build(piAi, modelsFile) };
  return cache.table;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isRate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function findPiAi(sdk: string): string | undefined {
  // The package is nested under pi's own node_modules, or hoisted next to it.
  const candidates = [join(sdk, "node_modules", PI_AI_PACKAGE), join(dirname(sdk), "pi-ai")];
  return candidates.find((dir) => existsSync(join(dir, "dist", "providers", "data")));
}

function stamp(file: string): string {
  try {
    const info = statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "-";
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function build(piAi: string, modelsFile: string): PriceTable {
  const entries = new Map<string, PriceEntry>();
  const data = join(piAi, "dist", "providers", "data");
  for (const file of readdirSync(data).filter((name) => name.endsWith(".json") && name !== ".manifest.json").sort()) {
    addPiData(entries, readJsonOr(join(data, file), file));
  }
  applyModelsJson(entries, modelsFile);
  const manifest = readJsonOr(join(data, ".manifest.json"), ".manifest.json");
  const pkg = readJsonOr(join(piAi, "package.json"), "package.json");
  const version = isObject(pkg) && typeof pkg.version === "string" ? pkg.version : "unknown";
  const asOf = isObject(manifest) && typeof manifest.generatedAt === "string" ? manifest.generatedAt : "";
  return { source: `${PI_AI_PACKAGE} ${version}`, asOf, entries: [...entries.values()] };
}

function readJsonOr(file: string, label: string): unknown {
  try {
    return readJson(file);
  } catch (error) {
    log.warn("usage", `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function addPiData(entries: Map<string, PriceEntry>, groups: unknown): void {
  if (!isObject(groups)) return;
  for (const models of Object.values(groups)) {
    if (!isObject(models)) continue;
    for (const model of Object.values(models)) {
      if (!isObject(model) || typeof model.provider !== "string" || typeof model.id !== "string") continue;
      const entry = priceOf(model.provider, model.id, model.cost);
      if (entry) put(entries, entry);
    }
  }
}

function applyModelsJson(entries: Map<string, PriceEntry>, file: string): void {
  if (!existsSync(file)) return;
  const config = readJsonOr(file, "models.json");
  const providers = isObject(config) && isObject(config.providers) ? config.providers : {};
  for (const [provider, settings] of Object.entries(providers)) {
    if (!isObject(settings)) continue;
    for (const definition of Array.isArray(settings.models) ? settings.models : []) {
      if (!isObject(definition) || typeof definition.id !== "string") continue;
      const entry = priceOf(provider, definition.id, definition.cost);
      if (entry) put(entries, entry);
    }
    if (!isObject(settings.modelOverrides)) continue;
    for (const [id, override] of Object.entries(settings.modelOverrides)) {
      const base = entries.get(keyOf(provider, id));
      if (!base || !isObject(override) || !isObject(override.cost)) continue;
      put(entries, withOverride(base, override.cost));
    }
  }
}

function priceOf(provider: string, model: string, cost: unknown): PriceEntry | undefined {
  if (!isObject(cost)) return undefined;
  const rates = ratesOf(cost);
  return rates && { provider, model, rates, tiers: tiersOf(cost.tiers) };
}

function withOverride(base: PriceEntry, cost: Json): PriceEntry {
  const pick = (value: unknown, fallback: number) => (isRate(value) ? value : fallback);
  const rates: ModelRates = {
    input: pick(cost.input, base.rates.input),
    output: pick(cost.output, base.rates.output),
    cacheRead: pick(cost.cacheRead, base.rates.cacheRead),
    cacheWrite: pick(cost.cacheWrite, base.rates.cacheWrite),
  };
  return { ...base, rates, tiers: cost.tiers === undefined ? base.tiers : tiersOf(cost.tiers) };
}

function ratesOf(value: unknown): ModelRates | undefined {
  if (!isObject(value)) return undefined;
  const { input, output, cacheRead, cacheWrite } = value;
  if (!isRate(input) || !isRate(output) || !isRate(cacheRead) || !isRate(cacheWrite)) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function tiersOf(value: unknown): PriceTier[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tier): PriceTier[] => {
    if (!isObject(tier) || !isRate(tier.inputTokensAbove)) return [];
    const rates = ratesOf(tier);
    return rates ? [{ inputTokensAbove: tier.inputTokensAbove, rates }] : [];
  });
}

const keyOf = (provider: string, model: string) => `${provider}\n${model}`;

function put(entries: Map<string, PriceEntry>, entry: PriceEntry): void {
  entries.set(keyOf(entry.provider, entry.model), entry);
}
