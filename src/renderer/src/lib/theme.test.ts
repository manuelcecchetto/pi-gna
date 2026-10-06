import { effectiveTheme, emptyThemes } from "../../../shared/themes";
import { emptySettings } from "../../../shared/settings";
import { describe, expect, it } from "vitest";
import { themeVars } from "./theme";

describe("themeVars", () => {
  it("leaves original CSS untouched in both modes", () => {
    const themes = emptyThemes();
    themes.global = { preset: "original" };
    for (const mode of ["light", "dark"] as const) expect(themeVars(effectiveTheme(themes, emptySettings(), undefined), mode)).toEqual({});
  });
  it("sets nothing for an empty theme", () => {
    expect(themeVars({ font: {}, colors: { light: {}, dark: {} } }, "dark")).toEqual({});
  });

  it("maps the palette of the mode shown, with shades that follow it, and the fonts", () => {
    const theme = { font: { ui: "Inter", mono: "JetBrains Mono", size: 15 }, colors: { light: { primary: "#2244ff" }, dark: { primary: "#818cf8", secondary: "#38bdf8", accent: "#fbbf24", background: "#0b0d12", fg: "#e5e7eb" } } };
    const dark = themeVars(theme, "dark");
    expect(dark).toMatchObject({
      "--accent": "#818cf8",
      "--c1": "#818cf8",
      "--secondary": "#38bdf8",
      "--highlight": "#fbbf24",
      "--canvas": "#0b0d12",
      "--panel": "color-mix(in srgb, #0b0d12, white 5%)",
      "--fg": "#e5e7eb",
      "--muted": "color-mix(in srgb, #e5e7eb, var(--canvas) 35%)",
      "--app-sans": '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif',
      "--app-mono": '"JetBrains Mono", "SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
      "--app-font-size": "15px",
    });
    const light = themeVars(theme, "light");
    expect(light["--accent"]).toBe("#2244ff");
    expect(light).not.toHaveProperty("--canvas");
  });
});
