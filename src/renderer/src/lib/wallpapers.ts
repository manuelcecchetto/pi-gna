// The empty state's wallpapers (settings.wallpaper): each a 🤌 in another form, at dusk for dark mode and by day for
// light mode, with small thumbnails for the picker in Settings. Files: assets/wallpapers/<id>-<dusk|day>.webp
// (2560 × 1440; the sky is 2048 × 1152) and thumbs/<id>-<dusk|day>.webp (480 × 270).
import type { CSSProperties } from "react";
import { type Wallpaper, WALLPAPERS } from "../../../shared/settings";

export const WALLPAPER_LABELS: Readonly<Record<Wallpaper, string>> = {
  sky: "Sky",
  stars: "Constellation",
  peak: "Dolomites",
  pines: "Pine forest",
  shadow: "Shadow",
  ink: "Ink wash",
  fresco: "Fresco",
  none: "None",
};

const files = import.meta.glob<string>("../assets/wallpapers/**/*.webp", { eager: true, query: "?url", import: "default" });

export interface WallpaperImages {
  dusk: string;
  day: string;
}

const images = (folder: string, id: Wallpaper): WallpaperImages | undefined => {
  const dusk = files[`../assets/wallpapers/${folder}${id}-dusk.webp`];
  const day = files[`../assets/wallpapers/${folder}${id}-day.webp`];
  return dusk && day ? { dusk, day } : undefined;
};

/** A wallpaper's images, full size or as thumbnails; none for "none". */
export const wallpaperImages = (id: Wallpaper, thumb = false): WallpaperImages | undefined => images(thumb ? "thumbs/" : "", id);

const LOOP = "pigna:wallpaper-loop";

/** The wallpaper after this one when they loop: every one but none, in the picker's order. */
export function nextWallpaper(id: Wallpaper): Wallpaper {
  const painted = WALLPAPERS.filter((other) => other !== "none");
  return painted[(painted.indexOf(id as (typeof painted)[number]) + 1) % painted.length] as Wallpaper;
}

function readLoop(storage: Pick<Storage, "getItem">): { picked: unknown; shown: Wallpaper } | undefined {
  try {
    const saved = JSON.parse(storage.getItem(LOOP) ?? "null") as { picked?: unknown; shown?: unknown } | null;
    return saved && WALLPAPERS.includes(saved.shown as Wallpaper) ? { picked: saved.picked, shown: saved.shown as Wallpaper } : undefined;
  } catch {
    return undefined;
  }
}

/** The wallpaper a new empty state shows: the one picked, or while they loop (settings.wallpaperLoop), the one after
 * the last shown. Where the loop is stays in localStorage, so it goes on after a restart; picking another wallpaper
 * starts it again from that one (from the sky for none). */
export function loopWallpaper(picked: Wallpaper, loop: boolean, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): Wallpaper {
  if (!loop) return picked;
  const last = readLoop(storage);
  const shown = last?.picked === picked ? nextWallpaper(last.shown) : picked === "none" ? "sky" : picked;
  storage.setItem(LOOP, JSON.stringify({ picked, shown }));
  return shown;
}

/** The CSS variables `.hero` and `.wallpaper-thumb` paint with (styles.css), which pick dusk or day by the appearance. */
export function wallpaperStyle(id: Wallpaper, thumb = false): CSSProperties | undefined {
  const found = wallpaperImages(id, thumb);
  return found && ({ "--wallpaper-dusk": `url("${found.dusk}")`, "--wallpaper-day": `url("${found.day}")` } as CSSProperties);
}
