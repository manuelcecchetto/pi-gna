import { describe, expect, it } from "vitest";
import { ACTIVE_GAP_CAP_MS, CONTEXT_EDGES, CONTEXT_TIER_EDGE, STEP_EDGES, USAGE_FACTS_VERSION } from "./usage";

const ascending = (edges: readonly number[]) => edges.every((edge, i) => i === 0 || edge > (edges[i - 1] as number));

describe("usage constants", () => {
  it("keeps histogram edges strictly ascending", () => {
    expect(ascending(CONTEXT_EDGES)).toBe(true);
    expect(ascending(STEP_EDGES)).toBe(true);
  });

  it("puts the pricing tier edge on the context histogram, so tier tokens are a bin boundary", () => {
    expect(CONTEXT_EDGES).toContain(CONTEXT_TIER_EDGE);
  });

  it("caps idle gaps at a positive window and starts facts at version 1", () => {
    expect(ACTIVE_GAP_CAP_MS).toBeGreaterThan(0);
    expect(USAGE_FACTS_VERSION).toBe(1);
  });
});
