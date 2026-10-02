// The pi logo (pi.dev/logo-auto.svg) as its 4x4 pixel grid, so it can assemble cell by cell like
// pi's terminal startup animation:
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

export function PiLogo({ size = 64, animate = false, className = "" }: { size?: number; animate?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 4 4" width={size} height={size} shapeRendering="crispEdges" className={className} role="img" aria-label="pi">
      {CELLS.map(([x, y, color], index) => (
        <rect
          key={`${x}${y}`}
          x={x}
          y={y}
          width={1.01}
          height={1.01}
          fill={color}
          className={animate ? "pi-cell" : undefined}
          style={animate ? { animationDelay: `${120 + index * 70}ms` } : undefined}
        />
      ))}
    </svg>
  );
}

const SPIN_MS = 1400;

/**
 * Loader: the logo's cells keep their shape while a coral -> blue -> yellow sweep turns around the glyph.
 * Each cell's phase is its angle around the center, so the colors appear to spin.
 */
export function PiSpinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 4 4" width={size} height={size} shapeRendering="crispEdges" className={`shrink-0 ${className}`} aria-hidden>
      {CELLS.map(([x, y, color]) => {
        const turn = (Math.atan2(y + 0.5 - 2, x + 0.5 - 2) / (2 * Math.PI) + 1) % 1;
        return (
          <rect
            key={`${x}${y}`}
            x={x}
            y={y}
            width={1.01}
            height={1.01}
            fill={color}
            className="pi-spin"
            style={{ animationDelay: `${-Math.round(turn * SPIN_MS)}ms`, animationDuration: `${SPIN_MS}ms` }}
          />
        );
      })}
    </svg>
  );
}
