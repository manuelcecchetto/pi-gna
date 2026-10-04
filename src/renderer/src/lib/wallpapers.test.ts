import { describe, expect, it } from "vitest";
import { WALLPAPERS } from "../../../shared/settings";
import { loopWallpaper, nextWallpaper, wallpaperImages, wallpaperStyle } from "./wallpapers";

describe("wallpapers", () => {
  it("has a dusk and a day image, full size and as a thumbnail, for every wallpaper but none", () => {
    for (const id of WALLPAPERS) {
      if (id === "none") continue;
      for (const thumb of [false, true]) {
        const images = wallpaperImages(id, thumb);
        expect(images, `${id}${thumb ? " thumbnail" : ""}`).toBeDefined();
        expect(images?.dusk).not.toBe(images?.day);
      }
    }
    expect(wallpaperImages("none")).toBeUndefined();
    expect(wallpaperStyle("none")).toBeUndefined();
  });

  it("loops through every painted wallpaper, from the one picked", () => {
    const seen: string[] = [];
    let id = nextWallpaper("ink");
    for (let i = 0; i < WALLPAPERS.length - 1; i++, id = nextWallpaper(id)) seen.push(id);
    expect(seen).toEqual(["fresco", "sky", "stars", "peak", "pines", "shadow", "ink"]);
    expect(nextWallpaper("none")).toBe("sky");
  });

  it("shows the next one at each new empty state while they loop, and starts again from a new pick", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
    expect(loopWallpaper("ink", false, storage)).toBe("ink");
    expect(saved.size).toBe(0);
    expect([1, 2, 3].map(() => loopWallpaper("ink", true, storage))).toEqual(["ink", "fresco", "sky"]);
    expect(loopWallpaper("peak", true, storage)).toBe("peak");
    expect(loopWallpaper("peak", true, storage)).toBe("pines");
    expect(loopWallpaper("none", true, storage)).toBe("sky");
    saved.set("pigna:wallpaper-loop", "{not json");
    expect(loopWallpaper("stars", true, storage)).toBe("stars");
  });
});
