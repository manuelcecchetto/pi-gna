import { describe, expect, it } from "vitest";
import { fastApplies, fastCommand, isFast, modelChipLabel, sharedNames } from "./fast";

describe("fast mode", () => {
  it("applies to OpenAI and ChatGPT models only", () => {
    expect(fastApplies("openai-codex")).toBe(true);
    expect(fastApplies("openai")).toBe(true);
    expect(fastApplies("anthropic")).toBe(false);
    expect(fastApplies(undefined)).toBe(false);
  });

  it("reads the extension's status", () => {
    expect(isFast({ fast: "on" })).toBe(true);
    expect(isFast({})).toBe(false);
  });

  // Another package's /fast (pi-openai-fast-mode) makes pi rename both: a plain /fast would go to the model as text.
  it("sends pi-gna's command by the name pi gave it", () => {
    const ours = { name: "fast:1", source: "extension" as const, sourceInfo: { path: "/Applications/pi-gna.app/Contents/Resources/app.asar.unpacked/resources/fast-extension.ts" } };
    const theirs = { name: "fast:2", source: "extension" as const, sourceInfo: { path: "/x/pi-openai-fast-mode/src/index.ts" } };
    expect(fastCommand(true, [theirs, ours])).toBe("/fast:1 on");
    expect(fastCommand(false, [{ ...ours, name: "fast" }])).toBe("/fast off");
    expect(fastCommand(true, undefined)).toBe("/fast on");
  });

  it("puts the thinking level on the model chip when the model has levels", () => {
    expect(modelChipLabel("GPT-6.1 Sol", "high", ["off", "low", "high"])).toBe("GPT-6.1 Sol · high");
    expect(modelChipLabel("Fake", "off", ["off"])).toBe("Fake");
    expect(modelChipLabel("Fake", undefined, undefined)).toBe("Fake");
  });

  it("finds the model names two providers share", () => {
    expect(sharedNames([{ name: "GPT-5.5" }, { name: "Opus" }, { name: "GPT-5.5" }])).toEqual(new Set(["GPT-5.5"]));
  });
});
