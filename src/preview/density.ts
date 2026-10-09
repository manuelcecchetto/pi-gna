// The display density (`devicePixelRatio`) as React state, for BetterOffice's DOCX canvas renderer: it reads the density
// when it paints but does not repaint when only the density changes (the window moved to a display with another one, or
// the page zoom changed), so vite.preview.config.ts adds `useDensity()` to its paint effect's dependencies.
import { useSyncExternalStore } from "react";

/**
 * Call `changed` when the density may have changed; returns the unsubscribe. A resolution query matches one density, so
 * it is re-armed after each change; a resize (page zoom) is a second signal.
 */
export function watchDensity(changed: () => void): () => void {
  let query: MediaQueryList | undefined;
  const fire = (): void => {
    arm();
    changed();
  };
  const arm = (): void => {
    query?.removeEventListener("change", fire);
    query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    query.addEventListener("change", fire);
  };
  arm();
  addEventListener("resize", changed);
  return () => {
    query?.removeEventListener("change", fire);
    removeEventListener("resize", changed);
  };
}

const density = (): number => devicePixelRatio;

/** The current density; the component renders again when it changes. */
export function useDensity(): number {
  return useSyncExternalStore(watchDensity, density);
}
