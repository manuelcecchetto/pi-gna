import { describe, expect, it } from "vitest";
import { onTv } from "./screen";

describe("onTv", () => {
  it("knows the TV app by its user agent suffix", () => {
    expect(onTv("Mozilla/5.0 (Linux; Android 11; G07_4K_GB_NF) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 pigna-tv")).toBe(true);
    expect(onTv("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(onTv("Mozilla/5.0 something pigna-tvx")).toBe(false);
  });
});
