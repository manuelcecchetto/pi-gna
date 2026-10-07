import { describe, expect, it } from "vitest";
import { clampView, distance, doubleTap, FIT, MAX_SCALE, midpoint, swipeStep, zoomAt } from "./pinch";

describe("pinch view", () => {
  it("keeps the focus point still while zooming", () => {
    const focus = { x: 40, y: -20 };
    const next = zoomAt(FIT, 2, focus);
    // The image point that was under the focus is still under it: x' = f - (f - x) * ratio.
    expect(next.x).toBeCloseTo(-40);
    expect(next.y).toBeCloseTo(20);
    const again = zoomAt(next, 1, focus);
    expect(again.x).toBeCloseTo(0);
  });
  it("limits the scale", () => {
    expect(zoomAt(FIT, 99, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
    expect(zoomAt(FIT, 0.2, { x: 0, y: 0 }).scale).toBe(1);
  });
  it("pans only as far as the zoomed image overflows", () => {
    expect(clampView({ scale: 1, x: 50, y: 50 }, { w: 300, h: 200 })).toEqual(FIT);
    expect(clampView({ scale: 2, x: 500, y: -500 }, { w: 300, h: 200 })).toEqual({ scale: 2, x: 150, y: -100 });
  });
  it("double tap toggles between fit and zoomed", () => {
    const zoomed = doubleTap(FIT, { x: 10, y: 10 });
    expect(zoomed.scale).toBe(2.5);
    expect(doubleTap(zoomed, { x: 0, y: 0 })).toEqual(FIT);
  });
  it("measures two fingers", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 2 })).toEqual({ x: 2, y: 1 });
  });
});

describe("swipeStep", () => {
  it("pages on a clear sideways drag: left for the next image, right for the previous", () => {
    expect(swipeStep(-90, 10)).toBe(1);
    expect(swipeStep(90, -20)).toBe(-1);
  });

  it("ignores short drags and mostly vertical ones", () => {
    expect(swipeStep(-40, 0)).toBe(0);
    expect(swipeStep(-90, 80)).toBe(0);
  });
});
