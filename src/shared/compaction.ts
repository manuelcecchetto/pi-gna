// pi's auto-compaction trigger, mirrored for display: pi compacts when context exceeds
// contextWindow - reserveTokens (docs/compaction.md). reserveTokens can be overridden per model.

export const DEFAULT_RESERVE_TOKENS = 16_384;

export interface CompactionSettings {
  reserveTokens?: number;
  modelOverrides?: Record<string, { reserveTokens?: number }>;
}

/** Exact `provider/modelId` override, then the ordinary setting, then pi's built-in default. */
export function resolveReserveTokens(settings: CompactionSettings | undefined, provider?: string, modelId?: string): number {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const override = provider && modelId ? settings?.modelOverrides?.[`${provider}/${modelId}`]?.reserveTokens : undefined;
  if (valid(override)) return override;
  return valid(settings?.reserveTokens) ? settings.reserveTokens : DEFAULT_RESERVE_TOKENS;
}
