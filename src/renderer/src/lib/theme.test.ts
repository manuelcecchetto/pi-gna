import { effectiveTheme, emptyThemes } from "../../../shared/themes";
import { emptySettings } from "../../../shared/settings";
import { describe, expect, it } from "vitest";
import { dataUrlBlob, imageWallpaperStyle, themeVars } from "./theme";

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

describe("image wallpapers", () => {
  // Chromium (Electron 44) drops a custom property longer than 2 MiB, so a multi-MB image never reached .hero inline.
  const CHROMIUM_VAR_LIMIT = 2 * 1024 * 1024;

  it("turns a multi-MB data: URL into a blob whose URL fits a CSS variable", async () => {
    // "ABCD" is the bytes 00 10 83: 800,000 of them are 2.4 MB of image as a 3.2 MB data: URL.
    const dataUrl = `data:image/png;base64,${"ABCD".repeat(800_000)}`;
    expect(dataUrl.length).toBeGreaterThan(CHROMIUM_VAR_LIMIT);
    const blob = dataUrlBlob(dataUrl)!;
    expect(blob.type).toBe("image/png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(2_400_000);
    expect([...bytes.subarray(0, 3), ...bytes.subarray(-3)]).toEqual([0x00, 0x10, 0x83, 0x00, 0x10, 0x83]);
    const url = URL.createObjectURL(blob);
    try {
      for (const value of Object.values(imageWallpaperStyle(url))) expect(String(value).length).toBeLessThan(200);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  it("rejects what is not a base64 data: URL", () => {
    expect(dataUrlBlob("https://example.com/a.png")).toBeNull();
    expect(dataUrlBlob("data:image/svg+xml,<svg/>")).toBeNull();
  });
});
