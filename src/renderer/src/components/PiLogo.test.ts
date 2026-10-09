import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cellTurn, PI, PiSpinner, spin, sweepColor } from "./PiLogo";

// The sweep as the CSS keyframes animated each cell's fill before PiSpinner became a strip: linear between the stops.
const STOPS: [number, number[]][] = [
  [0, [240, 144, 130]],
  [0.27, [240, 144, 130]],
  [0.33, [77, 154, 191]],
  [0.6, [77, 154, 191]],
  [0.66, [241, 190, 88]],
  [0.93, [241, 190, 88]],
  [1, [240, 144, 130]],
];
const fill = (phase: number) => {
  const to = STOPS.findIndex(([at]) => at > phase);
  const [from, a] = STOPS[to - 1]!;
  const [until, b] = STOPS[to]!;
  const mix = (phase - from) / (until - from);
  return `#${a.map((value, index) => Math.round(value + (b[index]! - value) * mix).toString(16).padStart(2, "0")).join("")}`;
};
// The cells of the logo, and each cell's CSS animation-delay before: -round(angle around the center as a turn * 1400ms).
const CELLS = ["0,0", "1,0", "2,0", "2,1", "0,1", "0,2", "1,2", "0,3", "3,2", "3,3"];
const oldDelay = (x: number, y: number) => -Math.round(((Math.atan2(y + 0.5 - 2, x + 0.5 - 2) / (2 * Math.PI) + 1) % 1) * 1400);

/** The cells an SVG background draws: "frame,x,y" -> color. */
function cells(markup: string, nth: number): Map<string, string> {
  const url = [...markup.matchAll(/background-image:url\(&quot;data:image\/svg\+xml,([^&]*)&quot;\)/g)][nth]?.[1];
  const svg = decodeURIComponent(url ?? "");
  const drawn = new Map<string, string>();
  for (const [, color, d] of svg.matchAll(/<path fill="(#[0-9a-f]{6})" d="([^"]*)"\/>/gi)) {
    for (const [, x, y] of d!.matchAll(/M(\d+) (\d+)h1\.01v1\.01h-1\.01z/g)) drawn.set(`${Math.floor(Number(x) / 4)},${Number(x) % 4},${y}`, color!.toLowerCase());
  }
  return drawn;
}

describe("PiSpinner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blends the logo colors the way the fill keyframes did", () => {
    for (let step = 0; step < 1000; step++) expect(sweepColor(step / 1000), String(step)).toBe(fill(step / 1000));
    expect(sweepColor(0.3)).toBe("#9f95a0");
    expect(sweepColor(0.45)).toBe("#4d9abf");
  });

  it("starts each cell where its animation delay did", () => {
    for (const cell of CELLS) {
      const [x, y] = cell.split(",").map(Number) as [number, number];
      expect(Math.round(cellTurn(x, y) * 1400), cell).toBe(-oldDelay(x, y));
    }
  });

  it("draws the still logo, and a strip of 84 frames of the sweep", () => {
    const markup = renderToStaticMarkup(createElement(PiSpinner, { size: 12, className: "ml-1" }));
    expect(markup).toMatch(/^<span class="pi-spinner shrink-0 ml-1" style="width:12px;height:12px;background-image:url\(/);
    expect(markup).toContain('aria-hidden="true"><span style="width:8400%;background-image:url(');
    const logo = cells(markup, 0);
    const colors: Record<string, string> = { "0,0": PI.coral, "1,0": PI.coral, "2,0": PI.coral, "2,1": PI.coral, "0,1": PI.blue, "0,2": PI.blue, "1,2": PI.blue, "0,3": PI.blue, "3,2": PI.yellow, "3,3": PI.yellow };
    expect(new Map([...logo].map(([key, color]) => [key.slice(2), color]))).toEqual(new Map(Object.entries(colors).map(([key, color]) => [key, color.toLowerCase()])));
    const strip = cells(markup, 1);
    expect(strip.size).toBe(84 * 10);
    for (let frame = 0; frame < 84; frame++) {
      for (const cell of CELLS) {
        const [x, y] = cell.split(",").map(Number) as [number, number];
        // The CSS animation at the frame's time: its delay put the cell that far into the sweep.
        expect(strip.get(`${frame},${cell}`), `${frame} ${cell}`).toBe(fill((((frame / 84) * 1400 - oldDelay(x, y)) / 1400) % 1));
      }
    }
  });

  it("steps through the strip on the compositor, and stays the still logo without motion", () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    const root = () => ({ firstElementChild: { animate }, dataset: {} as Record<string, string> });
    let reduced = false;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" }));

    const spinning = root();
    const stop = spin(spinning as unknown as HTMLElement);
    expect(animate).toHaveBeenCalledWith([{ transform: "translateX(0)" }, { transform: "translateX(-100%)" }], { duration: 1400, iterations: Infinity, easing: "steps(84)" });
    expect(spinning.dataset.spinning).toBe("");
    stop?.();
    expect(cancel).toHaveBeenCalledTimes(1);

    reduced = true;
    animate.mockClear();
    const still = root();
    expect(spin(still as unknown as HTMLElement)).toBeUndefined();
    expect(animate).not.toHaveBeenCalled();
    expect(still.dataset.spinning).toBeUndefined();
    expect(spin(null)).toBeUndefined();
  });
});
