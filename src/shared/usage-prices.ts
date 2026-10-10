import { type ModelRates, PRICE_PROVIDER_ALIASES, type PriceEntry, type PriceTable } from "./usage";

export interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceIndex {
  byProvider: Map<string, Map<string, PriceEntry>>;
  /** The first entry of each model id, whatever its provider. */
  byModel: Map<string, PriceEntry>;
}

export function priceIndex(table: PriceTable): PriceIndex {
  const byProvider = new Map<string, Map<string, PriceEntry>>();
  const byModel = new Map<string, PriceEntry>();
  for (const entry of table.entries) {
    let models = byProvider.get(entry.provider);
    if (!models) byProvider.set(entry.provider, (models = new Map()));
    models.set(entry.model, entry);
    if (!byModel.has(entry.model)) byModel.set(entry.model, entry);
  }
  return { byProvider, byModel };
}

/** The exact provider and model, then the provider's alias, then the model id under any provider. */
export function findPrice(index: PriceIndex, provider: string, model: string): PriceEntry | undefined {
  const alias = PRICE_PROVIDER_ALIASES[provider];
  return (
    index.byProvider.get(provider)?.get(model) ??
    (alias === undefined ? undefined : index.byProvider.get(alias)?.get(model)) ??
    index.byModel.get(model)
  );
}

/** USD at list price. The tier is the highest one the turn's input (input + cacheRead + cacheWrite) exceeds, and the whole turn is priced at its rates. */
export function costOf(usage: TurnTokens, price: PriceEntry): number {
  const context = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates: ModelRates = price.rates;
  let edge = -Infinity;
  for (const tier of price.tiers) {
    if (context > tier.inputTokensAbove && tier.inputTokensAbove > edge) {
      rates = tier.rates;
      edge = tier.inputTokensAbove;
    }
  }
  return (
    (usage.input * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}
