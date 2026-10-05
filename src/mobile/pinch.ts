// Pinch-zoom and pan of the image lightbox, as pure functions of a view: `scale` and a translation `x`, `y` in px from the
// centered, unscaled image (transform: translate(x, y) scale(scale), origin at the center).
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
export const FIT: View = { scale: MIN_SCALE, x: 0, y: 0 };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Keep the image covering the screen as far as it is larger than it: no panning at fit size. `size` is the unscaled image box. */
export function clampView(view: View, size: { w: number; h: number }): View {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const limitX = (size.w * (scale - 1)) / 2;
  const limitY = (size.h * (scale - 1)) / 2;
  return { scale, x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY) };
}

/** Change the scale around `focus` (px from the image center) so the point under it stays put. */
export function zoomAt(view: View, scale: number, focus: { x: number; y: number }): View {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const ratio = next / view.scale;
  return { scale: next, x: focus.x - (focus.x - view.x) * ratio, y: focus.y - (focus.y - view.y) * ratio };
}

export const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A double tap: back to fit when zoomed, else 2.5x around the tap. */
export function doubleTap(view: View, focus: { x: number; y: number }): View {
  return view.scale > 1.01 ? FIT : zoomAt(view, 2.5, focus);
}
