// Custom themes in the window (src/shared/themes.ts): the theme of the project on screen becomes CSS variables on
// <html>, over styles.css's defaults, for the explicit theme or device-local system mode. Inline visuals
// read the same variables (VisualFrame), so they follow the theme too.
import type { CSSProperties } from "react";
import type { EffectiveTheme, Mode, Palette } from "../../../shared/themes";
import type { Wallpaper } from "../../../shared/settings";

/** What the empty state shows for the theme on screen: a built-in wallpaper or an image, and the project's logo. */
export interface Look {
  /** The project's built-in wallpaper, over settings.wallpaper (and its loop). */
  wallpaper?: Wallpaper;
  /** The project's own wallpaper image (data: URL). */
  wallpaperUrl?: string;
  logo?: string;
}

const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif';
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

const mix = (color: string, other: string, percent: number) => `color-mix(in srgb, ${color}, ${other} ${percent}%)`;
const alpha = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** The variables a palette sets in one mode. What it leaves out keeps styles.css's value; the shades around a color it
 * sets (sunken and sidebar around the background, raised around the panel, muted and faint around the text) follow it. */
function paletteVars(palette: Palette, mode: Mode): Record<string, string> {
  const vars: Record<string, string> = {};
  // Sunken surfaces and the sidebar sit a step darker than the canvas; panels a step lighter in dark mode, darker in light.
  const deeper = "black";
  const lift = mode === "dark" ? "white" : "black";
  const { primary, secondary, accent, background, panel, fg } = palette;
  if (primary) Object.assign(vars, { "--accent": primary, "--accent-soft": alpha(primary, mode === "dark" ? 16 : 10), "--c1": primary });
  if (secondary) Object.assign(vars, { "--secondary": secondary, "--c2": secondary });
  if (accent) Object.assign(vars, { "--highlight": accent, "--c3": accent });
  if (background) {
    vars["--canvas"] = background;
    vars["--sunken"] = mix(background, deeper, mode === "dark" ? 18 : 2);
    vars["--sidebar"] = mix(background, deeper, mode === "dark" ? 18 : 4);
    if (!panel) Object.assign(vars, { "--panel": mix(background, lift, mode === "dark" ? 5 : 3), "--raised": mix(background, lift, mode === "dark" ? 10 : 7) });
  }
  if (panel) Object.assign(vars, { "--panel": panel, "--raised": mix(panel, lift, mode === "dark" ? 6 : 4) });
  if (fg) {
    const base = "var(--canvas)";
    Object.assign(vars, {
      "--fg": fg,
      "--muted": mix(fg, base, 35),
      "--faint": mix(fg, base, 58),
      "--line": alpha(fg, 8),
      "--line-strong": alpha(fg, 14),
    });
  }
  return vars;
}

/** Every variable the theme sets in `mode`; an empty theme sets none. */
export function themeVars(theme: Pick<EffectiveTheme, "font" | "colors">, mode: Mode): Record<string, string> {
  const vars = paletteVars(theme.colors[mode], mode);
  const { ui, mono, size } = theme.font;
  if (ui) vars["--app-sans"] = `"${ui}", ${SANS}`;
  if (mono) vars["--app-mono"] = `"${mono}", ${MONO}`;
  if (size) vars["--app-font-size"] = `${size}px`;
  return vars;
}

let applied: string[] = [];

/** Sets the variables on <html>, removing the ones the last theme set and this one does not; then tells the inline
 * visuals to re-read them. */
export function applyThemeVars(vars: Record<string, string>, root: HTMLElement = document.documentElement): void {
  for (const name of applied) if (!(name in vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  applied = Object.keys(vars);
  // Text selection takes the theme's accent only when it sets one; otherwise it stays the system's.
  root.toggleAttribute("data-highlight", "--highlight" in vars);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Fired on window after a theme is applied: inline visuals post the new tokens to their frames. */
export const THEME_EVENT = "pigna-theme";

/** The empty state's backdrop for an image wallpaper: the same picture at dusk and by day. */
export const imageWallpaperStyle = (url: string): CSSProperties => ({ "--wallpaper-dusk": `url("${url}")`, "--wallpaper-day": `url("${url}")` }) as CSSProperties;
