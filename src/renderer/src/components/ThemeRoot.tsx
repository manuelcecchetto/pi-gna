// Applies the theme of the project on screen (src/shared/themes.ts, lib/theme.ts): its colors and fonts as CSS
// variables on <html>, its appearance mode through main (themes.active), and its wallpaper and logo as the store's
// `look`, which the empty state shows. Renders nothing.
import { useEffect, useMemo, useState } from "react";
import { projectOf } from "../../../shared/board";
import { effectiveTheme, type Themes } from "../../../shared/themes";
import { dataUrlBlob } from "../lib/theme";
import { useThemeAppearance } from "../lib/theme-hooks";
import { store, useApp } from "../state/app";

/** The project on screen: the open page's, else the active chat's. */
export const useScreenProject = (): string | undefined =>
  useApp((state) => {
    const chat = state.active && state.sessions[state.active]?.cwd;
    const cwd = state.page?.cwd ?? chat;
    return cwd ? projectOf(cwd) : undefined;
  });

/** A project theme's wallpaper or logo as a blob: URL (main sends a data: URL, too long for a CSS variable: see
 * dataUrlBlob), fetched again only when that project's theme changes and revoked when it does. */
export function useThemeImage(themes: Themes, project: string | undefined, kind: "wallpaper" | "logo"): string | undefined {
  const theme = project ? themes.projects[project] : undefined;
  const path = kind === "logo" ? theme?.logo?.path : theme?.wallpaper && "path" in theme.wallpaper ? theme.wallpaper.path : undefined;
  const key = project && path ? `${project}\n${kind}\n${JSON.stringify(theme)}` : undefined;
  const [loaded, setLoaded] = useState<{ key: string; url?: string }>();
  useEffect(() => {
    if (!key || !project) return;
    const request = window.studio.themes.image(project, kind).catch(() => null);
    let live = true;
    let objectUrl: string | undefined;
    void request.then((url) => {
      if (!live) return;
      const blob = url ? dataUrlBlob(url) : null;
      objectUrl = blob ? URL.createObjectURL(blob) : undefined;
      setLoaded({ key, url: objectUrl });
    });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, project, kind]);
  return key && loaded?.key === key ? loaded.url : undefined;
}

export function ThemeRoot() {
  const project = useScreenProject();
  const themes = useApp((state) => state.themes);
  const theme = useApp((state) => state.settings.theme);
  const wallpaper = useApp((state) => state.settings.wallpaper);
  const effective = useMemo(() => effectiveTheme(themes, { theme, wallpaper }, project), [themes, theme, wallpaper, project]);

  useEffect(() => window.studio.themes.active(project ?? null), [project]);
  useThemeAppearance(effective);

  const wallpaperUrl = useThemeImage(themes, effective.project, "wallpaper");
  const logo = useThemeImage(themes, effective.project, "logo");
  const own = effective.project ? themes.projects[effective.project]?.wallpaper : undefined;
  const builtin = own ? ("builtin" in own ? own.builtin : "none") : undefined;
  useEffect(() => {
    const look = builtin || wallpaperUrl || logo ? { wallpaper: builtin, wallpaperUrl, logo } : undefined;
    store.set((s) => (JSON.stringify(s.look) === JSON.stringify(look) ? s : { ...s, look }));
  }, [builtin, wallpaperUrl, logo]);
  return null;
}
