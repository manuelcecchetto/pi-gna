import { describe, expect, it } from "vitest";
import { applyMenuChoice, detectMenu } from "./composer-menu";

describe("detectMenu", () => {
  it("opens the command list for a leading slash only", () => {
    expect(detectMenu("/com", 4)).toEqual({ kind: "command", query: "com", start: 0 });
    expect(detectMenu("hi /com", 7)).toBeUndefined();
    expect(detectMenu("/compact now", 12)).toBeUndefined();
  });
  it("opens the file list for an @ after whitespace", () => {
    expect(detectMenu("look at @src/ap", 15)).toEqual({ kind: "file", query: "src/ap", start: 8 });
    expect(detectMenu("a@b", 3)).toBeUndefined();
    expect(detectMenu("@", 1)).toEqual({ kind: "file", query: "", start: 0 });
  });
});

describe("applyMenuChoice", () => {
  it("replaces the trigger and keeps the text after the caret", () => {
    const menu = detectMenu("see @sr and more", 7)!;
    expect(applyMenuChoice("see @sr and more", menu, "@src/a.ts ", 7)).toEqual({ text: "see @src/a.ts  and more", caret: 14 });
  });
});
