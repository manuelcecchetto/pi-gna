// The pi logo (pi.dev/logo-auto.svg) as its 4x4 pixel grid:
//   coral coral coral .
//   blue  .     coral .
//   blue  blue  .     yellow
//   blue  .     .     yellow
const CORAL = "#F09082";
const BLUE = "#4D9ABF";
const YELLOW = "#F1BE58";
const CELLS: [number, number, string][] = [
  [0, 0, CORAL],
  [1, 0, CORAL],
  [2, 0, CORAL],
  [2, 1, CORAL],
  [0, 1, BLUE],
  [0, 2, BLUE],
  [1, 2, BLUE],
  [0, 3, BLUE],
  [3, 2, YELLOW],
  [3, 3, YELLOW],
];

export const PI_COLORS = [CORAL, BLUE, YELLOW];
export const PI = { coral: CORAL, blue: BLUE, yellow: YELLOW };

/** The logo; `color` paints every cell one color (sidebar state marks). */
export function PiLogo({ size = 64, color, className = "" }: { size?: number; color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 4 4" width={size} height={size} shapeRendering="crispEdges" className={className} role="img" aria-label="pi">
      {CELLS.map(([x, y, cellColor]) => (
        <rect key={`${x}${y}`} x={x} y={y} width={1.01} height={1.01} fill={color ?? cellColor} />
      ))}
    </svg>
  );
}

const SPIN_MS = 1400;
/** One frame per 60th of a second. */
const SPIN_FRAMES = 84;

/** Each cell holds a pure logo color and switches quickly, so mid-transition greys never show at 12px. */
const SWEEP: [number, string][] = [
  [0, CORAL],
  [0.27, CORAL],
  [0.33, BLUE],
  [0.6, BLUE],
  [0.66, YELLOW],
  [0.93, YELLOW],
  [1, CORAL],
];

/** A cell's color at a point (0 to 1) of the sweep, blending linearly between the stops. */
export function sweepColor(phase: number): string {
  let previous = SWEEP[0] as [number, string];
  for (const stop of SWEEP) {
    if (stop[0] > phase) return blend(previous[1], stop[1], (phase - previous[0]) / (stop[0] - previous[0]));
    previous = stop;
  }
  return previous[1];
}

function blend(from: string, to: string, mix: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * mix).toString(16).padStart(2, "0")).join("")}`;
}

/** Where in the sweep a cell starts: its angle around the glyph's center, so the colors appear to spin. */
export const cellTurn = (x: number, y: number) => Math.round(((Math.atan2(y + 0.5 - 2, x + 0.5 - 2) / (2 * Math.PI) + 1) % 1) * SPIN_MS) / SPIN_MS;

/** Cells as an SVG background, each frame of a strip 4 units wide; same-colored cells share a path. */
function cellsImage(frames: (([x, y, color]: (typeof CELLS)[number]) => string)[]): string {
  const paths = new Map<string, string>();
  frames.forEach((colorOf, frame) => {
    for (const cell of CELLS) paths.set(colorOf(cell), `${paths.get(colorOf(cell)) ?? ""}M${frame * 4 + cell[0]} ${cell[1]}h1.01v1.01h-1.01z`);
  });
  const body = [...paths].map(([color, d]) => `<path fill="${color}" d="${d}"/>`).join("");
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frames.length * 4} 4" shape-rendering="crispEdges">${body}</svg>`)}")`;
}

/** The still logo, and the sweep: a strip of SPIN_FRAMES frames of the glyph that PiSpinner slides through. */
const LOGO_IMAGE = cellsImage([([, , color]) => color]);
const SWEEP_IMAGE = cellsImage(Array.from({ length: SPIN_FRAMES }, (_, frame) => ([x, y]) => sweepColor((frame / SPIN_FRAMES + cellTurn(x, y)) % 1)));

/**
 * Starts a PiSpinner's sweep: one transform that steps through the strip, which the compositor runs. Per-cell color
 * animations (fill, or opacity layers) restyled every cell on every frame the page drew, and as CSS animations they
 * woke the page each cycle to dispatch animationiteration, which React listens for on its root. Without motion
 * (prefers-reduced-motion) the spinner is the still logo.
 */
export function spin(root: HTMLElement | null) {
  const strip = root?.firstElementChild;
  if (!root || !strip || typeof strip.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.dataset.spinning = "";
  const sweep = strip.animate([{ transform: "translateX(0)" }, { transform: "translateX(-100%)" }], { duration: SPIN_MS, iterations: Infinity, easing: `steps(${SPIN_FRAMES})` });
  return () => sweep.cancel();
}

/** Loader: the logo's cells keep their shape while a coral -> blue -> yellow sweep turns around the glyph. */
export function PiSpinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <span ref={spin} className={`pi-spinner shrink-0 ${className}`} style={{ width: size, height: size, backgroundImage: LOGO_IMAGE }} aria-hidden>
      <span style={{ width: `${SPIN_FRAMES * 100}%`, backgroundImage: SWEEP_IMAGE }} />
    </span>
  );
}
