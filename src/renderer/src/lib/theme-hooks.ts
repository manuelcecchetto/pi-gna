import { useEffect, useState } from "react";
import type { EffectiveTheme } from "../../../shared/themes";
import { applyThemeVars, themeVars } from "./theme";

/** Device-local system mode; a phone must never change the Mac's native appearance. */
export function useThemeAppearance(theme: EffectiveTheme): void {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const mode = theme.base === "system" ? (dark ? "dark" : "light") : theme.base;
  useEffect(() => {
    document.documentElement.dataset.themeMode = mode;
    applyThemeVars({ ...themeVars(theme, mode), "--theme-mode": mode });
  }, [theme, mode]);
}
