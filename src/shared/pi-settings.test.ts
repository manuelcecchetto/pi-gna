import { describe, expect, it } from "vitest";
import { patchPiSettings, readPiValues } from "./pi-settings";

const file = {
  defaultProvider: "anthropic",
  defaultThinkingLevel: "lots",
  compaction: { reserveTokens: 30000, keepRecentTokens: -1, modelOverrides: { "a/b": { reserveTokens: 1 } } },
  retry: "yes",
  packages: ["npm:pi-mcp-adapter"],
};

describe("readPiValues", () => {
  it("reads the editable keys pi would accept", () => {
    expect(readPiValues(file)).toEqual({ defaultProvider: "anthropic", "compaction.reserveTokens": 30000 });
    expect(readPiValues(null)).toEqual({});
  });
});

describe("patchPiSettings", () => {
  it("sets and unsets keys and leaves the rest of the file alone", () => {
    const next = patchPiSettings(file, { defaultModel: "claude-opus-5-5", defaultProvider: null, "compaction.enabled": false, "images.blockImages": true });
    expect(next).toEqual({
      defaultThinkingLevel: "lots",
      compaction: { reserveTokens: 30000, keepRecentTokens: -1, modelOverrides: { "a/b": { reserveTokens: 1 } }, enabled: false },
      retry: "yes",
      packages: ["npm:pi-mcp-adapter"],
      defaultModel: "claude-opus-5-5",
      images: { blockImages: true },
    });
    expect(file.defaultProvider).toBe("anthropic");
    expect(patchPiSettings({}, { "images.autoResize": null })).toEqual({});
  });

  it("refuses keys it does not edit, values pi would not accept and a parent that is no object", () => {
    expect(() => patchPiSettings(file, { packages: [] })).toThrow("does not change packages");
    expect(() => patchPiSettings(file, { "retry.maxRetries": 99 })).toThrow();
    expect(() => patchPiSettings(file, { defaultThinkingLevel: "lots" })).toThrow();
    expect(() => patchPiSettings(file, { defaultModel: " " })).toThrow();
    expect(() => patchPiSettings(file, { "retry.enabled": false })).toThrow("retry in pi's settings is not an object");
    expect(() => patchPiSettings(file, ["defaultModel"])).toThrow();
  });
});
