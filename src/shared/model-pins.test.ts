import { describe, expect, it } from "vitest";
import { pinnedFirst } from "./model-pins";

const m = (provider: string, id: string) => ({ provider, id });
const MODELS = [m("anthropic", "opus"), m("openai", "gpt"), m("openai-codex", "gpt"), m("google", "gemini")];

describe("pinnedFirst", () => {
  it("keeps pi's order without pins", () => {
    expect(pinnedFirst(MODELS, [])).toEqual(MODELS);
  });
  it("puts the pins first in pin order, by provider, and skips pins pi does not list", () => {
    const sorted = pinnedFirst(MODELS, ["google/gemini", "gone/model", "openai-codex/gpt"]);
    expect(sorted).toEqual([m("google", "gemini"), m("openai-codex", "gpt"), m("anthropic", "opus"), m("openai", "gpt")]);
  });
});
