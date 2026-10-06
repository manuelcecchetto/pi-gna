import { expect, it } from "vitest";
import { THEME_PRESETS } from "./theme-presets";
import { effectiveTheme, emptyThemes, isColor } from "./themes";
import { emptySettings } from "./settings";

const luminance = (hex: string) => {
  const channels = hex.slice(1).match(/../g)!.map((v) => parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};
it("ships ten distinct readable palettes plus the unchanged Original default", () => {
  expect(THEME_PRESETS).toHaveLength(11);
  expect(new Set(THEME_PRESETS.map((p) => p.id)).size).toBe(11);
  for (const preset of THEME_PRESETS.slice(1)) for (const palette of Object.values(preset.colors)) {
    expect(Object.values(palette).every(isColor)).toBe(true);
    const p = palette as Record<string, string>;
    for (const bg of [p.background!, p.panel!]) for (const fg of [p.fg!, p.primary!, p.secondary!]) {
      const a = luminance(bg), b = luminance(fg);
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${preset.id} ${bg} / ${fg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const mode of ["light", "dark"] as const) {
    const themes = emptyThemes();
    expect(effectiveTheme(themes, emptySettings(), undefined).colors[mode]).toEqual({});
    themes.global = { preset: "original" };
    expect(effectiveTheme(themes, emptySettings(), undefined).colors[mode]).toEqual({});
  }
});
