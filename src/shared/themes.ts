// Custom themes (userData/themes.json): your colors, fonts, wallpaper and logo, for every project or for one. Main owns
// the file and applies every change through applyThemeOp, so every field is checked; the agent's set_theme tool
// (resources/theme-extension.ts) and Settings > Appearance change it the same way: a patch of the fields to change,
// where a missing field stays as it is and null resets it.
//
// The global appearance mode and built-in wallpaper stay in pi-gna's settings (settings.theme, settings.wallpaper);
// the global theme here adds fonts and colors on top. A project's theme overrides both, field by field. Card worktrees
// share their project's theme (projectOf).
import { THEME_PRESETS, themePreset, type ThemePresetId } from "./theme-presets";
import { projectOf } from "./board";
import { type Settings, THEMES, type Theme, WALLPAPERS, type Wallpaper } from "./settings";

export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

/** The colors a theme may set, for one mode. `primary` is the app's accent (buttons, links, selection rings). */
export const COLOR_KEYS = ["primary", "secondary", "accent", "background", "panel", "fg"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export type Palette = Partial<Record<ColorKey, string>>;

export interface ThemeFont {
  /** An installed font family's name: nothing is downloaded. */
  ui?: string;
  mono?: string;
  /** Base text size in px. */
  size?: number;
}

/** A built-in wallpaper (or none), or an image inside the project (its path relative to the project). */
export type ThemeWallpaper = { builtin: Wallpaper } | { path: string };

export interface ThemeSpec {
  preset?: ThemePresetId;
  /** A project's appearance mode; the global one is settings.theme. */
  base?: Theme;
  font?: ThemeFont;
  colors?: Partial<Record<Mode, Palette>>;
  /** A project's wallpaper; the global one is settings.wallpaper. */
  wallpaper?: ThemeWallpaper;
  /** A project's logo: an image inside the project, shown on its empty chat and in the sidebar. */
  logo?: { path: string };
}

export interface Themes {
  version: 1;
  global: ThemeSpec;
  /** By project folder (projectOf). */
  projects: Record<string, ThemeSpec>;
}

export type ThemeScope = "global" | { project: string };

/** `patch` is checked by applyThemeOp: the set_theme fields, with null to reset one. */
export type ThemeOp = { type: "set"; scope: ThemeScope; patch: unknown } | { type: "reset"; scope: ThemeScope };

export const FONT_SIZE = { min: 11, max: 20 } as const;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"] as const;
/** Largest image a theme may use, in bytes. */
export const IMAGE_MAX_BYTES = { wallpaper: 12 * 1024 * 1024, logo: 2 * 1024 * 1024 } as const;

export class ThemeError extends Error {}

export const emptyThemes = (): Themes => ({ version: 1, global: {}, projects: {} });

/** Hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or a functional color with numbers only: rgb(), hsl(), hwb(), lab(), lch(),
 * oklab(), oklch(). Nothing that could close the declaration or load anything. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = "[-+]?(?:\\d*\\.\\d+|\\d+)(?:e[-+]?\\d+)?";
const CHANNEL = new RegExp(`^${NUMBER}%?$`, "i");
const HUE = new RegExp(`^${NUMBER}(?:deg|grad|rad|turn)?$`, "i");
/** Intentionally a literal-color grammar: no variable, URL, relative color or executable CSS expressions. */
export function isColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  if (HEX.test(value)) return true;
  const fn = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(([^()]+)\)$/i.exec(value);
  if (!fn) return false;
  const name = fn[1]!.toLowerCase();
  const body = fn[2]!.trim();
  let channels: string[], alpha: string | undefined;
  if (body.includes(",")) {
    if (!["rgb", "rgba", "hsl", "hsla"].includes(name) || body.includes("/")) return false;
    channels = body.split(",").map((s) => s.trim());
    if (channels.length === 4) alpha = channels.pop();
  } else {
    const parts = body.split("/");
    if (parts.length > 2) return false;
    channels = parts[0]!.trim().split(/\s+/);
    alpha = parts[1]?.trim();
  }
  if (channels.length !== 3 || (alpha !== undefined && !CHANNEL.test(alpha))) return false;
  return channels.every((c, i) => {
    const hue = (name.startsWith("hsl") || name === "hwb") ? i === 0 : (name.endsWith("lch") && i === 2);
    if (hue) return HUE.test(c);
    if ((name.startsWith("hsl") || name === "hwb") && !c.endsWith("%")) return false;
    return CHANNEL.test(c);
  });
}

/** A font family's name: letters, digits, spaces, dots, dashes and underscores, so it cannot be a url() or close the
 * declaration. */
const FONT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
export const isFontName = (value: unknown): value is string => typeof value === "string" && FONT.test(value) && value.trim() === value;

/** A relative path inside the project, as written (forward slashes, no `..`, no absolute path); main also checks the
 * real file is inside the project and an image. */
export function imagePathError(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) return "a path must be a non-empty string";
  if (value.startsWith("/") || value.startsWith("~") || /^[a-z]:/i.test(value) || value.includes("\\")) return `${value} is not relative to the project`;
  if (value.split("/").some((part) => part === "..")) return `${value} leaves the project`;
  const extension = value.split(".").at(-1)?.toLowerCase() ?? "";
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return `${value} is not an image (${IMAGE_EXTENSIONS.join(", ")})`;
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ThemeError(`unknown field ${where}${key} (expected ${keys.join(", ")})`);
}

/** Merges a patch object field by field: undefined keeps, null resets, anything else goes through `check`. */
function mergeFields<T extends object>(current: T | undefined, patch: unknown, keys: readonly (keyof T & string)[], where: string, check: (key: keyof T & string, value: unknown) => unknown): T | undefined {
  if (patch === null) return undefined;
  if (!isObject(patch)) throw new ThemeError(`${where.replace(/\.$/, "") || "the theme"} must be an object or null`);
  onlyKeys(patch, keys, where);
  const next: Record<string, unknown> = { ...current };
  for (const key of keys) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const value = patch[key] === null ? undefined : check(key, patch[key]);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length ? (next as T) : undefined;
}

const SPEC_KEYS = ["preset", "base", "font", "colors", "wallpaper", "logo"] as const;
/** The global theme's own fields: its mode and wallpaper are settings.theme and settings.wallpaper. */
const GLOBAL_KEYS = ["preset", "font", "colors"] as const;

function checkPalette(current: Palette | undefined, patch: unknown, where: string): Palette | undefined {
  return mergeFields<Palette>(current, patch, COLOR_KEYS, where, (key, value) => {
    if (!isColor(value)) throw new ThemeError(`${where}${key}: ${JSON.stringify(value)} is not a color (use #rrggbb, or rgb(), hsl(), oklch() and the like)`);
    return value;
  });
}

function checkWallpaper(current: ThemeWallpaper | undefined, value: unknown): ThemeWallpaper | undefined {
  if (value === "none") return { builtin: "none" };
  if (!isObject(value)) throw new ThemeError(`wallpaper must be "none", { "builtin": "${WALLPAPERS.join('" | "')}" } or { "path": "<image in the project>" }`);
  if (!Object.keys(value).length) return current;
  if ("builtin" in value) {
    onlyKeys(value, ["builtin"], "wallpaper.");
    if (value.builtin === null) return undefined;
    if (!WALLPAPERS.includes(value.builtin as Wallpaper)) throw new ThemeError(`unknown wallpaper ${JSON.stringify(value.builtin)} (expected ${WALLPAPERS.join(", ")})`);
    return { builtin: value.builtin as Wallpaper };
  }
  onlyKeys(value, ["path"], "wallpaper.");
  if (value.path === null) return undefined;
  const error = imagePathError(value.path);
  if (error) throw new ThemeError(`wallpaper: ${error}`);
  return { path: value.path as string };
}

/** Applies a set_theme patch to one theme: returns the merged theme, or throws ThemeError naming the bad field. */
export function mergeTheme(current: ThemeSpec, patch: unknown, scope: "global" | "project"): ThemeSpec {
  const keys = scope === "global" ? GLOBAL_KEYS : SPEC_KEYS;
  return (
    mergeFields<ThemeSpec>(current, patch, keys, "", (key, value) => {
      switch (key) {
        case "preset":
          if (!THEME_PRESETS.some((preset) => preset.id === value)) throw new ThemeError(`unknown preset ${JSON.stringify(value)}`);
          return value;
        case "base":
          if (!THEMES.includes(value as Theme)) throw new ThemeError(`base must be ${THEMES.join(", ")}`);
          return value;
        case "font":
          return mergeFields<ThemeFont>(current.font, value, ["ui", "mono", "size"], "font.", (field, font) => {
            if (field === "size") {
              if (!Number.isInteger(font) || (font as number) < FONT_SIZE.min || (font as number) > FONT_SIZE.max) throw new ThemeError(`font.size must be a whole number of px from ${FONT_SIZE.min} to ${FONT_SIZE.max}`);
              return font;
            }
            if (!isFontName(font)) throw new ThemeError(`font.${field}: ${JSON.stringify(font)} is not a font name (an installed family's name, letters, digits, spaces, . _ -)`);
            return font;
          });
        case "colors":
          return mergeFields<Partial<Record<Mode, Palette>>>(current.colors, value, MODES, "colors.", (mode, palette) => checkPalette(current.colors?.[mode], palette, `colors.${mode}.`));
        case "wallpaper":
          return checkWallpaper(current.wallpaper, value);
        case "logo":
          return mergeFields(current.logo, value, ["path"], "logo.", (_field, path) => {
            const error = imagePathError(path);
            if (error) throw new ThemeError(`logo: ${error}`);
            return path;
          });
      }
    }) ?? {}
  );
}

const scopeKey = (scope: ThemeScope): string | undefined => (scope === "global" ? undefined : scope.project);

/** A scope's theme as stored (empty when it has none). */
export const scopeTheme = (themes: Themes, scope: ThemeScope): ThemeSpec => (scope === "global" ? themes.global : (themes.projects[scope.project] ?? {}));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Returns the same value when nothing changes; throws ThemeError for an invalid op. */
export function applyThemeOp(themes: Themes, op: ThemeOp): Themes {
  if (op?.type !== "set" && op?.type !== "reset") throw new ThemeError(`unknown theme change ${String((op as { type?: unknown } | null)?.type)}`);
  if (op.scope !== "global" && (!isObject(op.scope) || Object.keys(op.scope).length !== 1 || typeof op.scope.project !== "string")) throw new ThemeError("a project theme needs the project absolute path");
  const project = scopeKey(op.scope);
  if (op.scope !== "global" && (typeof project !== "string" || !project.startsWith("/"))) throw new ThemeError("a project theme needs the project's absolute path");
  const current = scopeTheme(themes, op.scope);
  const next = op.type === "reset" ? {} : mergeTheme(current, op.patch, project === undefined ? "global" : "project");
  if (same(current, next)) return themes;
  if (project === undefined) return { ...themes, global: next };
  const { [project]: _, ...projects } = themes.projects;
  return { ...themes, projects: Object.keys(next).length ? { ...projects, [project]: next } : projects };
}

/** Lenient: a malformed theme is dropped whole (counted in `dropped`); throws when it is no themes file at all. */
export function parseThemes(raw: unknown): { themes: Themes; dropped: number } {
  if (!isObject(raw)) throw new ThemeError("not an object");
  const themes = emptyThemes();
  let dropped = 0;
  const read = (value: unknown, scope: "global" | "project"): ThemeSpec | undefined => {
    try {
      return mergeTheme({}, value, scope);
    } catch {
      dropped++;
      return undefined;
    }
  };
  if (raw.global !== undefined) themes.global = read(raw.global, "global") ?? {};
  for (const [project, value] of Object.entries(isObject(raw.projects) ? raw.projects : {})) {
    const theme = project.startsWith("/") ? read(value, "project") : (dropped++, undefined);
    if (theme && Object.keys(theme).length) themes.projects[project] = theme;
  }
  return { themes, dropped };
}

/** What a project looks like: its theme over the global one, field by field, over pi-gna's settings. */
export interface EffectiveTheme {
  base: Theme;
  font: ThemeFont;
  colors: Record<Mode, Palette>;
  wallpaper: ThemeWallpaper;
  logo?: { path: string };
  /** The project whose theme applies, if it has one (wallpaper and logo paths are relative to it). */
  project?: string;
}

export function effectiveTheme(themes: Themes, settings: Pick<Settings, "theme" | "wallpaper">, cwd: string | undefined): EffectiveTheme {
  const project = cwd ? projectOf(cwd) : undefined;
  const own = (project && themes.projects[project]) || {};
  const { global } = themes;
  // An explicit project preset starts fresh; otherwise inherit the global preset and its edits.
  const inherited = own.preset ? {} : global;
  const palette = themePreset(own.preset ?? global.preset).colors as Record<Mode, Palette>;
  return {
    base: own.base ?? settings.theme,
    font: { ...inherited.font, ...own.font },
    colors: { light: { ...palette.light, ...inherited.colors?.light, ...own.colors?.light }, dark: { ...palette.dark, ...inherited.colors?.dark, ...own.colors?.dark } },
    wallpaper: own.wallpaper ?? { builtin: settings.wallpaper },
    ...(own.logo && { logo: own.logo }),
    ...(project && themes.projects[project] && { project }),
  };
}

/** The set_theme tool's request (the patch fields beside `scope`) and reply. */
export type ThemeRequest = { scope?: "project" | "global" } & Record<string, unknown>;
export interface ThemeResponse {
  text: string;
}
