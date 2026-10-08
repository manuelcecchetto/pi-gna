// What the context meter shows: how full the window is, and how far auto-compaction is.
import type { SessionStats } from "../../../shared/protocol";
import type { SessionState } from "../../../shared/session-state";

export type ContextLevel = "unknown" | "ok" | "warn" | "high";

export interface ContextSummary {
  /** null right after compaction: pi only knows again after the next response. */
  used: number | null;
  window: number;
  /** Percent of the whole window, 0..100. */
  percent: number | null;
  /** Token count at which pi auto-compacts, or null when auto-compaction is off. */
  compactAt: number | null;
  /** Tokens left before auto-compaction (or before the window is full when it is off). */
  left: number | null;
  /** Color: by distance to auto-compaction, since that is when context gets summarized. */
  level: ContextLevel;
}

export function summarizeContext(stats: SessionStats | undefined, reserveTokens: number, autoCompaction: boolean): ContextSummary | undefined {
  const usage = stats?.contextUsage;
  if (!usage || usage.contextWindow <= 0) return undefined;
  const window = usage.contextWindow;
  const compactAt = autoCompaction ? Math.max(0, window - reserveTokens) : null;
  const used = usage.tokens;
  if (used === null) return { used: null, window, percent: null, compactAt, left: null, level: "unknown" };
  const limit = compactAt ?? window;
  const share = limit > 0 ? used / limit : 1;
  const level: ContextLevel = share >= 0.9 ? "high" : share >= 0.7 ? "warn" : "ok";
  return { used, window, percent: Math.min(100, (used / window) * 100), compactAt, left: Math.max(0, limit - used), level };
}

interface PromptTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Share of prompt tokens served from the provider's cache, 0..1, or null when nothing was sent. */
export function cacheHitRate(usage: PromptTokens | undefined): number | null {
  if (!usage) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? usage.cacheRead / prompt : null;
}

/** Cache hit rate of the last request that reported prompt tokens. */
export function lastCacheHit(items: SessionState["items"]): number | null {
  return cacheHitRate(lastRequestUsage(items));
}

/** Usage of the latest assistant response that actually reported prompt tokens. */
export function lastRequestUsage(items: SessionState["items"]): PromptTokens | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    const usage = item.message.usage;
    if (usage && usage.input + usage.cacheRead + usage.cacheWrite > 0) return usage;
  }
  return undefined;
}
