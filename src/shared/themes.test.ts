import { describe, expect, it } from "vitest";
import { worktreeCwd } from "./board";
import { emptySettings } from "./settings";
import { applyThemeOp, effectiveTheme, emptyThemes, isColor, isFontName, mergeTheme, parseThemes, ThemeError } from "./themes";

describe("mergeTheme", () => {
  it("keeps missing fields, resets null ones and merges nested objects", () => {
    const first = mergeTheme({}, { base: "dark", font: { ui: "Inter", size: 15 }, colors: { dark: { primary: "#4f46e5", fg: "#e5e7eb" } } }, "project");
    expect(first).toEqual({ base: "dark", font: { ui: "Inter", size: 15 }, colors: { dark: { primary: "#4f46e5", fg: "#e5e7eb" } } });
    const second = mergeTheme(first, { font: { size: null, mono: "JetBrains Mono" }, colors: { dark: { primary: "oklch(0.7 0.15 250)" }, light: { background: "#ffffff" } } }, "project");
    expect(second).toEqual({
      base: "dark",
      font: { ui: "Inter", mono: "JetBrains Mono" },
      colors: { dark: { primary: "oklch(0.7 0.15 250)", fg: "#e5e7eb" }, light: { background: "#ffffff" } },
    });
    expect(mergeTheme(second, { base: null, colors: null }, "project")).toEqual({ font: { ui: "Inter", mono: "JetBrains Mono" } });
    expect(mergeTheme(second, { font: { ui: null, mono: null } }, "project")).not.toHaveProperty("font");
  });

  it("takes wallpapers and logos as project images or built-in ids", () => {
    expect(mergeTheme({}, { wallpaper: "none" }, "project")).toEqual({ wallpaper: { builtin: "none" } });
    expect(mergeTheme({}, { wallpaper: { builtin: "stars" }, logo: { path: "assets/logo.svg" } }, "project")).toEqual({ wallpaper: { builtin: "stars" }, logo: { path: "assets/logo.svg" } });
    expect(mergeTheme({}, { wallpaper: { path: "art/sky.webp" } }, "project")).toEqual({ wallpaper: { path: "art/sky.webp" } });
  });

  it("preserves omitted image fields and resets null image fields", () => {
    const current = { wallpaper: { path: "art/sky.webp" }, logo: { path: "logo.svg" } };
    expect(mergeTheme(current, { wallpaper: {}, logo: {} }, "project")).toEqual(current);
    expect(mergeTheme(current, { wallpaper: { path: null }, logo: { path: null } }, "project")).toEqual({});
    expect(mergeTheme({ wallpaper: { builtin: "stars" } }, { wallpaper: { builtin: null } }, "project")).toEqual({});
  });

  it.each([
    [{ shade: "#fff" }, /unknown field shade/],
    [{ colors: { dark: { primary: "red; background: url(x)" } } }, /colors\.dark\.primary/],
    [{ colors: { dark: { primary: "var(--x)" } } }, /not a color/],
    [{ colors: { dim: {} } }, /unknown field colors\.dim/],
    [{ font: { ui: "Inter'; } body { x" } }, /font\.ui/],
    [{ font: { ui: "url(https://x)" } }, /font\.ui/],
    [{ font: { size: 40 } }, /font\.size/],
    [{ base: "sepia" }, /base must be/],
    [{ wallpaper: { builtin: "moon" } }, /unknown wallpaper/],
    [{ wallpaper: { path: "../secret.png" } }, /leaves the project/],
    [{ logo: { path: "/etc/logo.png" } }, /not relative/],
    [{ logo: { path: "notes.txt" } }, /not an image/],
  ])("refuses %j", (patch, message) => {
    expect(() => mergeTheme({}, patch, "project")).toThrow(message);
  });

  it("keeps the global theme to fonts and colors (its mode and wallpaper are settings)", () => {
    expect(() => mergeTheme({}, { base: "dark" }, "global")).toThrow(ThemeError);
    expect(() => mergeTheme({}, { logo: { path: "a.png" } }, "global")).toThrow(/unknown field logo/);
    expect(mergeTheme({}, { font: { mono: "Menlo" } }, "global")).toEqual({ font: { mono: "Menlo" } });
  });
});

describe("colors and fonts", () => {
  it("accepts hex and numeric color functions only", () => {
    for (const color of ["#fff", "#ffff", "#1b1b1d", "#1b1b1dcc", "rgb(10 20 30)", "rgba(10, 20, 30, 0.5)", "hsl(210 50% 40%)", "oklch(0.7 0.15 250 / 50%)"]) expect(isColor(color), color).toBe(true);
    for (const color of ["red", "#ggg", "rgb(1 2 3); x", "url(a)", "rgb(calc(1) 2 3)", "rgb(var(--a))", "expression(alert(1))", "rgb(foo)", "rgb(1)", "rgb(1 2 3 4)", "hsl(1 2 3)", "rgb(1 2 3 /)", "rgb(1 2 3 / 1 / 2)"]) expect(isColor(color), color).toBe(false);
  });

  it("accepts family names only", () => {
    expect(isFontName("JetBrains Mono")).toBe(true);
    expect(isFontName("SF Pro Text")).toBe(true);
    for (const font of ["", " Inter", '"Inter"', "Inter, serif", "a".repeat(65)]) expect(isFontName(font), font).toBe(false);
  });
});

describe("applyThemeOp", () => {
  it("sets and resets a project's theme, leaving the value alone when nothing changes", () => {
    const set = applyThemeOp(emptyThemes(), { type: "set", scope: { project: "/repo" }, patch: { base: "light" } });
    expect(set.projects).toEqual({ "/repo": { base: "light" } });
    expect(applyThemeOp(set, { type: "set", scope: { project: "/repo" }, patch: { base: "light" } })).toBe(set);
    expect(applyThemeOp(set, { type: "set", scope: { project: "/repo" }, patch: { base: null } }).projects).toEqual({});
    expect(applyThemeOp(set, { type: "reset", scope: { project: "/repo" } }).projects).toEqual({});
    expect(() => applyThemeOp(set, { type: "set", scope: { project: "repo" }, patch: {} })).toThrow(/absolute path/);
    expect(() => applyThemeOp(set, { type: "set", scope: null as never, patch: {} })).toThrow(/project absolute path/);
  });
});

describe("effectiveTheme", () => {
  it("layers the project over the global theme over the settings, and worktrees share their project's", () => {
    let themes = applyThemeOp(emptyThemes(), { type: "set", scope: "global", patch: { font: { ui: "Inter" }, colors: { dark: { primary: "#111111", fg: "#eeeeee" } } } });
    themes = applyThemeOp(themes, { type: "set", scope: { project: "/repo" }, patch: { base: "dark", colors: { dark: { primary: "#222222" } }, logo: { path: "logo.png" } } });
    const settings = { ...emptySettings(), wallpaper: "ink" as const };
    expect(effectiveTheme(themes, settings, "/repo")).toEqual({
      base: "dark",
      font: { ui: "Inter" },
      colors: { light: {}, dark: { primary: "#222222", fg: "#eeeeee" } },
      wallpaper: { builtin: "ink" },
      logo: { path: "logo.png" },
      project: "/repo",
    });
    expect(effectiveTheme(themes, settings, worktreeCwd("/Users/me", "abc123", "/repo")).project).toBe("/repo");
    expect(effectiveTheme(themes, settings, "/elsewhere")).toMatchObject({ base: "system", colors: { dark: { primary: "#111111" } } });
    expect(effectiveTheme(themes, settings, "/elsewhere")).not.toHaveProperty("project");
  });
});

describe("parseThemes", () => {
  it("drops malformed themes whole and keeps the rest", () => {
    const { themes, dropped } = parseThemes({ global: { font: { ui: "Inter" } }, projects: { "/a": { base: "dark" }, "/b": { colors: { dark: { primary: "nope" } } }, relative: { base: "dark" } } });
    expect(themes).toEqual({ version: 1, global: { font: { ui: "Inter" } }, projects: { "/a": { base: "dark" } } });
    expect(dropped).toBe(2);
    expect(() => parseThemes([])).toThrow();
  });
});
