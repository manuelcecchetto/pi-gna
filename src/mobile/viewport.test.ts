import { describe, expect, it } from "vitest";
import { displayCornerRadius, isIos, keyboardOpen } from "./viewport";

describe("viewport helpers", () => {
  it("maps screen sizes to the display corner radius in either orientation", () => {
    expect(displayCornerRadius(402, 874)).toBe(62);
    expect(displayCornerRadius(874, 402)).toBe(62);
    expect(displayCornerRadius(393, 852)).toBe(55);
    expect(displayCornerRadius(375, 667)).toBe(0); // SE: square corners
  });
  it("detects iOS, including iPadOS reporting a Mac", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", "iPhone", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Linux; Android 15)", "Linux armv8l", 5)).toBe(false);
  });
  it("tells the keyboard from small viewport changes", () => {
    expect(keyboardOpen(812, 480)).toBe(true);
    expect(keyboardOpen(812, 790)).toBe(false);
  });
});
