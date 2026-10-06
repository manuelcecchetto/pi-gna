// Same theme and visual tokens as desktop, resolved against the phone's foreground project and system mode.
// Images come from the authenticated host API, not a file URL or a path on the phone.
import { useEffect, useMemo, useState } from "react";
import { effectiveTheme, emptyThemes } from "../shared/themes";
import { useStore } from "../renderer/src/lib/store";
import { useThemeAppearance } from "../renderer/src/lib/theme-hooks";
import type { ChatUi } from "../renderer/src/lib/chat-ui";
import type { Look } from "../renderer/src/lib/theme";
import type { HostClient } from "./client/host-client";

const EMPTY = emptyThemes();
export function ThemeRoot({ client, ui, cwd }: { client: HostClient; ui: ChatUi; cwd?: string }) {
  const themes = useStore(client.store, (s) => s.global.themes ?? EMPTY);
  const settings = useStore(client.store, (s) => s.global.settings);
  const theme = useMemo(() => effectiveTheme(themes, settings ?? { theme: "system", wallpaper: "none" }, cwd), [themes, settings, cwd]);
  useThemeAppearance(theme);
  const key = JSON.stringify([theme.project, theme.wallpaper, theme.logo]);
  const [images, setImages] = useState<{ key: string; wallpaperUrl?: string; logo?: string }>();
  useEffect(() => {
    let live = true;
    const image = (kind: "wallpaper" | "logo", needed: boolean) => theme.project && needed
      ? client.call("themes.image", { project: theme.project, kind }).catch(() => null)
      : Promise.resolve(null);
    void Promise.all([image("wallpaper", "path" in theme.wallpaper), image("logo", !!theme.logo)]).then(([wallpaperUrl, logo]) => {
      if (live) setImages({ key, wallpaperUrl: wallpaperUrl ?? undefined, logo: logo ?? undefined });
    });
    return () => { live = false; };
  }, [client, key]);
  useEffect(() => {
    const own = theme.project ? themes.projects[theme.project]?.wallpaper : undefined;
    const look: Look = {
      wallpaper: own ? ("builtin" in own ? own.builtin : "none") : undefined,
      wallpaperUrl: images?.key === key ? images.wallpaperUrl : undefined,
      logo: images?.key === key ? images.logo : undefined,
    };
    ui.store.set((s) => ({ ...s, look }));
  }, [ui, theme, themes, images, key]);
  return null;
}
