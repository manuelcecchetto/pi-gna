import { describe, expect, it } from "vitest";
import { DEVICE_PRESETS, fitViewport, findPreset, resolveViewport, rotateViewport, toInputCoords, userAgentFor } from "./viewport";

describe("presets", () => {
  it("looks up by id or label, case-insensitively", () => {
    expect(findPreset("iphone-15")?.width).toBe(393);
    expect(findPreset("iPhone 15")?.id).toBe("iphone-15");
    expect(findPreset("nope")).toBeUndefined();
    expect(DEVICE_PRESETS.length).toBeGreaterThan(4);
  });

  it("resolves a preset with its dpr, mobile flag and UA profile", () => {
    expect(resolveViewport({ preset: "pixel-8" })).toEqual({
      width: 412, height: 915, dpr: 2.625, mobile: true, touch: true, userAgent: "android", label: "Pixel 8", source: "user",
    });
    const laptop = resolveViewport({ preset: "laptop", source: "agent" });
    expect(laptop).toMatchObject({ mobile: false, touch: false, userAgent: "native", source: "agent" });
  });

  it("rejects unknown presets with the known ids", () => {
    expect(() => resolveViewport({ preset: "gameboy" })).toThrow(/unknown preset "gameboy".*iphone-15/);
  });
});

describe("resolveViewport", () => {
  it("accepts width and/or height", () => {
    expect(resolveViewport({ width: 600, height: 500 })).toMatchObject({ width: 600, height: 500, dpr: 1, label: "Custom" });
    expect(resolveViewport({ width: 600 })).toMatchObject({ width: 600, height: 800 });
    expect(resolveViewport({ preset: "iphone-15", width: 500 })).toMatchObject({ width: 500, height: 852, label: "Custom", mobile: true });
  });

  it("derives the other edge from an aspect ratio", () => {
    expect(resolveViewport({ aspect: "16/9", width: 1280 })).toMatchObject({ width: 1280, height: 720 });
    expect(resolveViewport({ aspect: "9:19.5", height: 780 })).toMatchObject({ width: 360, height: 780 });
    expect(resolveViewport({ aspect: 0.5, height: 800 })).toMatchObject({ width: 400, height: 800 });
  });

  it("explains aspect misuse", () => {
    expect(() => resolveViewport({ aspect: "16:9" })).toThrow("aspect needs width or height");
    expect(() => resolveViewport({ aspect: "16:9", width: 800, height: 600 })).toThrow(/exactly one/);
    expect(() => resolveViewport({ aspect: "wide", width: 800 })).toThrow(/not understood/);
    expect(() => resolveViewport({ aspect: 0, width: 800 })).toThrow(/positive/);
  });

  it("swaps edges for orientation", () => {
    expect(resolveViewport({ preset: "iphone-15", orientation: "landscape" })).toMatchObject({ width: 852, height: 393 });
    expect(resolveViewport({ preset: "iphone-15", orientation: "portrait" })).toMatchObject({ width: 393, height: 852 });
    expect(resolveViewport({ width: 300, height: 900, orientation: "landscape" })).toMatchObject({ width: 900, height: 300 });
    expect(() => resolveViewport({ orientation: "sideways" as never })).toThrow(/orientation/);
  });

  it("clamps and rounds to the limits", () => {
    expect(resolveViewport({ width: 50, height: 99999 })).toMatchObject({ width: 200, height: 3840 });
    expect(resolveViewport({ width: 500.6, height: 400.4 })).toMatchObject({ width: 501, height: 400 });
    expect(resolveViewport({ width: 500, dpr: 9 }).dpr).toBe(4);
    expect(resolveViewport({ width: 500, dpr: 0.2 }).dpr).toBe(1);
    expect(() => resolveViewport({ width: Number.NaN })).toThrow(/width must be a finite number/);
    expect(() => resolveViewport({ dpr: "2" as never })).toThrow(/dpr/);
  });

  it("picks a UA profile when mobile is toggled on a custom size", () => {
    expect(resolveViewport({ width: 400, height: 800, mobile: true })).toMatchObject({ mobile: true, touch: true, userAgent: "iphone" });
    expect(resolveViewport({ width: 900, height: 800, mobile: true }).userAgent).toBe("ipad");
    expect(resolveViewport({ preset: "iphone-15", mobile: false })).toMatchObject({ mobile: false, touch: false, userAgent: "native" });
  });

  it("keeps the device's UA profile across edits that carry it", () => {
    // the Dimensions bar's rotate and DPR edits: a rotated iPhone stays an iPhone, a Pixel stays Android
    expect(resolveViewport({ width: 852, height: 393, dpr: 3, mobile: true, userAgent: "iphone" }).userAgent).toBe("iphone");
    expect(resolveViewport({ width: 412, height: 915, dpr: 2, mobile: true, userAgent: "android" }).userAgent).toBe("android");
    expect(resolveViewport({ width: 412, height: 915, mobile: true, userAgent: "native" }).userAgent).toBe("iphone");
    expect(resolveViewport({ width: 412, height: 915, mobile: false, userAgent: "android" }).userAgent).toBe("native");
    expect(() => resolveViewport({ width: 400, height: 800, mobile: true, userAgent: "nokia" as never })).toThrow(/userAgent/);
  });

  it("rotateViewport swaps edges only", () => {
    const s = resolveViewport({ preset: "ipad" });
    expect(rotateViewport(s)).toEqual({ ...s, width: 1180, height: 820 });
  });
});

describe("fitViewport", () => {
  const pane = { width: 800, height: 600 };

  it("keeps a smaller viewport at scale 1, centred", () => {
    expect(fitViewport(pane, { width: 400, height: 300 })).toEqual({ scale: 1, bounds: { x: 200, y: 150, width: 400, height: 300 } });
  });

  it("scales a larger viewport down to fit the tighter edge", () => {
    expect(fitViewport(pane, { width: 1600, height: 900 })).toEqual({ scale: 0.5, bounds: { x: 0, y: 75, width: 800, height: 450 } });
    expect(fitViewport(pane, { width: 400, height: 1200 })).toEqual({ scale: 0.5, bounds: { x: 300, y: 0, width: 200, height: 600 } });
  });

  it("handles extreme aspect ratios and degenerate panes", () => {
    const wide = fitViewport(pane, { width: 3840, height: 200 });
    expect(wide.bounds.width).toBe(800);
    expect(wide.bounds.height).toBe(42);
    expect(wide.scale).toBeCloseTo(800 / 3840);
    const none = fitViewport({ width: 0, height: 0 }, { width: 400, height: 300 });
    expect(none.scale).toBe(0.01);
    expect(none.bounds.width).toBeGreaterThanOrEqual(1);
  });

  it("honours a user zoom above 1", () => {
    expect(fitViewport(pane, { width: 300, height: 200 }, { zoom: 2 })).toEqual({ scale: 2, bounds: { x: 100, y: 100, width: 600, height: 400 } });
  });

  it("converts input coordinates to view pixels", () => {
    expect(toInputCoords(250, 100, 0.5)).toEqual({ x: 125, y: 50 });
  });
});

describe("userAgentFor", () => {
  it("is null for native", () => {
    expect(userAgentFor("native", "152.0.7778.96")).toBeNull();
  });

  it("derives iPhone profile from the running Chromium version", () => {
    const p = userAgentFor("iphone", "152.0.7778.96")!;
    expect(p.userAgent).toContain("iPhone");
    expect(p.userAgent).toContain("CriOS/152.0.0.0");
    expect(p.metadata).toMatchObject({ mobile: true, platform: "iOS", model: "iPhone", fullVersion: "152.0.7778.96" });
    expect(p.metadata.brands).toContainEqual({ brand: "Chromium", version: "152" });
    expect(p.headers["Sec-CH-UA-Mobile"]).toBe("?1");
    expect(p.headers["Sec-CH-UA-Platform"]).toBe('"iOS"');
  });

  it("covers android and ipad", () => {
    const a = userAgentFor("android", "160.0.1.2")!;
    expect(a.userAgent).toMatch(/Android 14.*Chrome\/160\.0\.0\.0 Mobile/);
    expect(a.headers["Sec-CH-UA-Platform"]).toBe('"Android"');
    expect(userAgentFor("ipad", "160.0.1.2")!.userAgent).toContain("iPad");
  });
});
