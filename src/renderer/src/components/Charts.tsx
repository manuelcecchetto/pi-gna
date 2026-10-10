// Hand-written SVG and CSS charts for the Usage section. Colours come only from the theme's variables (styles.css
// --chart-1..8 and the tokens they derive from), so light, dark and project themes all recolour them. Interactive
// charts show the same tooltip for the pointer and for the arrow keys once they have focus.
import { type KeyboardEvent, type PointerEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { formatCompact } from "../lib/format";
import {
  addDays,
  calendarFrame,
  colorScale,
  dayOffset,
  everyNth,
  formatDay,
  formatShare,
  heatFill,
  heatLevel,
  monthName,
  niceTicks,
  WEEKDAYS,
} from "./chart-scale";

export interface Series {
  key: string;
  label: string;
}

export interface Bucket {
  label: string;
  values: Record<string, number>;
}

export interface Amount extends Series {
  value: number;
}

interface Cell {
  col: number;
  row: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const labelStyle = { fill: "var(--faint)", fontSize: 10, fontFamily: "var(--font-mono)" } as const;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const KEY_STEPS: Record<string, Cell> = {
  ArrowLeft: { col: -1, row: 0 },
  ArrowRight: { col: 1, row: 0 },
  ArrowUp: { col: 0, row: -1 },
  ArrowDown: { col: 0, row: 1 },
};

/** The cell a tooltip describes: moved by the pointer, or by the arrow keys while the chart has focus. */
function useCursor(cols: number, rows: number, start: Cell) {
  const id = useId();
  const [cell, setCell] = useState(start);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const bounds = (next: Cell): Cell => ({ col: clamp(next.col, 0, Math.max(0, cols - 1)), row: clamp(next.row, 0, Math.max(0, rows - 1)) });
  const at = bounds(cell);
  const move = (next: Cell) => setCell((prev) => (prev.col === next.col && prev.row === next.row ? prev : bounds(next)));
  const shown = hover || focused;
  return {
    id,
    at,
    move,
    shown,
    frame: {
      role: "img" as const,
      tabIndex: 0,
      "aria-describedby": shown ? id : undefined,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
      onKeyDown: (event: KeyboardEvent) => {
        const step = KEY_STEPS[event.key];
        if (!step) return;
        event.preventDefault();
        move({ col: at.col + step.col, row: at.row + step.row });
      },
    },
  };
}

function Tooltip({ id, x, y, width, children }: { id: string; x: number; y: number; width: number; children: ReactNode }) {
  const flip = x > width / 2;
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute z-10 min-w-40 max-w-64 rounded-lg border border-line-strong bg-raised px-2.5 py-2 text-[12px] leading-5 text-fg shadow-[0_12px_32px_-12px_rgb(0_0_0/0.5)]"
      style={{ left: x, top: y, transform: flip ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}
    >
      {children}
    </div>
  );
}

function TipRow({ color, label, value, total }: { color?: string; label: string; value: string; total?: boolean }) {
  return (
    <div className={`flex items-center gap-2 whitespace-nowrap ${total ? "mt-1 border-t border-line pt-1 font-medium" : ""}`}>
      {color && <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />}
      <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
      <span className="font-mono tabular-nums text-fg">{value}</span>
    </div>
  );
}

function Empty({ summary, height = 96 }: { summary: string; height?: number }) {
  return (
    <div role="img" aria-label={summary} className="flex items-center justify-center text-[12px] text-faint" style={{ height }}>
      No data in this range
    </div>
  );
}

export function Legend({ items }: { items: Series[] }) {
  const color = colorScale(items.map((item) => item.key));
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: color(item.key) }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function HeatScale({ low = "Less", high = "More" }: { low?: string; high?: string }) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-faint">
      <span>{low}</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <span key={level} className="size-2.5 rounded-[2px]" style={{ background: heatFill(level) }} />
      ))}
      <span>{high}</span>
    </div>
  );
}

const AXIS_LEFT = 40;
const AXIS_TOP = 8;
const AXIS_BOTTOM = 20;

export function StackedBars({
  series,
  buckets,
  format,
  summary,
  height = 168,
}: {
  series: Series[];
  buckets: Bucket[];
  format: (value: number) => string;
  summary: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const cursor = useCursor(buckets.length, 1, { col: buckets.length - 1, row: 0 });
  const color = colorScale(series.map((item) => item.key));
  const totals = buckets.map((bucket) => sum(series.map((item) => bucket.values[item.key] ?? 0)));
  const peak = Math.max(0, ...totals);
  if (!buckets.length || peak <= 0) return <Empty summary={summary} height={height} />;

  const ticks = niceTicks(peak);
  const plotW = Math.max(0, width - AXIS_LEFT);
  const plotH = height - AXIS_TOP - AXIS_BOTTOM;
  const band = plotW / buckets.length;
  const barW = Math.max(1, band * 0.68);
  const y = (value: number) => AXIS_TOP + plotH - (value / ticks.max) * plotH;
  const labelEvery = everyNth(buckets.length, plotW / 56);
  const active = buckets[cursor.at.col]!;
  const centre = AXIS_LEFT + (cursor.at.col + 0.5) * band;

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!band) return;
    const box = event.currentTarget.getBoundingClientRect();
    cursor.move({ col: Math.floor((event.clientX - box.left - AXIS_LEFT) / band), row: 0 });
  };

  return (
    <div
      ref={ref}
      className="relative w-full rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-accent"
      {...cursor.frame}
      aria-label={summary}
      onPointerMove={onPointerMove}
    >
      <svg width={width} height={height} aria-hidden className="block overflow-visible">
        {ticks.ticks.map((tick) => (
          <g key={tick}>
            <line x1={AXIS_LEFT} x2={width} y1={y(tick)} y2={y(tick)} style={{ stroke: "var(--line)" }} />
            <text x={AXIS_LEFT - 6} y={y(tick) + 3.5} textAnchor="end" style={labelStyle}>
              {formatCompact(tick)}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) => {
          const x = AXIS_LEFT + index * band + (band - barW) / 2;
          let stacked = 0;
          return (
            <g key={`${index}:${bucket.label}`}>
              {series.map((item) => {
                const value = bucket.values[item.key] ?? 0;
                if (value <= 0) return null;
                const segmentTop = y(stacked + value);
                const segmentBottom = y(stacked);
                stacked += value;
                return (
                  <rect
                    key={item.key}
                    x={x}
                    y={segmentTop}
                    width={barW}
                    height={Math.max(0, segmentBottom - segmentTop)}
                    opacity={cursor.shown && index !== cursor.at.col ? 0.5 : 1}
                    style={{ fill: color(item.key) }}
                  />
                );
              })}
            </g>
          );
        })}
        {buckets.map((bucket, index) =>
          index % labelEvery === 0 ? (
            <text key={`x${index}`} x={AXIS_LEFT + (index + 0.5) * band} y={height - 5} textAnchor="middle" style={labelStyle}>
              {bucket.label}
            </text>
          ) : null,
        )}
        {cursor.shown && <line x1={centre} x2={centre} y1={AXIS_TOP} y2={AXIS_TOP + plotH} style={{ stroke: "var(--line-strong)" }} />}
      </svg>
      {cursor.shown && (
        <Tooltip id={cursor.id} x={centre} y={AXIS_TOP} width={width}>
          <div className="mb-1 font-medium text-fg">{active.label}</div>
          {[...series].reverse().flatMap((item) => {
            const value = active.values[item.key] ?? 0;
            return value > 0 ? [<TipRow key={item.key} color={color(item.key)} label={item.label} value={format(value)} />] : [];
          })}
          <TipRow label="Total" value={format(totals[cursor.at.col] ?? 0)} total />
        </Tooltip>
      )}
    </div>
  );
}

const GAP = 3;
const LABEL_W = 30;
const LABEL_H = 14;

interface HeatGridProps {
  cols: number;
  rows: number;
  colLabels: (string | null)[];
  rowLabels: (string | null)[];
  fill: (col: number, row: number) => string | null;
  tip: (col: number, row: number) => { title: string; value: string };
  start: Cell;
  square: boolean;
  minCell: number;
  maxCell: number;
  summary: string;
}

function HeatGrid({ cols, rows, colLabels, rowLabels, fill, tip, start, square, minCell, maxCell, summary }: HeatGridProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const cursor = useCursor(cols, rows, start);
  const labelW = rowLabels.some(Boolean) ? LABEL_W : 0;
  const labelH = colLabels.some(Boolean) ? LABEL_H : 0;
  const cellW = clamp(Math.floor((width - labelW) / cols) - GAP, minCell, maxCell);
  const cellH = square ? cellW : 14;
  const pitchX = cellW + GAP;
  const pitchY = cellH + GAP;
  const content = cursor.shown ? tip(cursor.at.col, cursor.at.row) : null;

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const col = Math.floor((event.clientX - box.left - labelW) / pitchX);
    const row = Math.floor((event.clientY - box.top - labelH) / pitchY);
    if (col >= 0 && row >= 0 && col < cols && row < rows) cursor.move({ col, row });
  };
  const anchorX = labelW + cursor.at.col * pitchX + cellW / 2;
  const anchorY = labelH + (cursor.at.row + 1) * pitchY;

  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const background = fill(col, row);
      if (!background) continue;
      const active = cursor.shown && cursor.at.col === col && cursor.at.row === row;
      cells.push(
        <rect
          key={`${col}:${row}`}
          x={labelW + col * pitchX}
          y={labelH + row * pitchY}
          width={cellW}
          height={cellH}
          rx={2}
          style={{ fill: background, stroke: active ? "var(--fg)" : undefined }}
        />,
      );
    }
  }

  return (
    <div
      ref={ref}
      className="relative w-full rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-accent"
      {...cursor.frame}
      aria-label={summary}
      onPointerMove={onPointerMove}
    >
      <div className="overflow-x-auto">
        <svg width={labelW + cols * pitchX - GAP} height={labelH + rows * pitchY - GAP} aria-hidden className="block">
          {colLabels.map((label, col) =>
            label ? (
              <text key={`c${col}`} x={labelW + col * pitchX} y={LABEL_H - 4} style={labelStyle}>
                {label}
              </text>
            ) : null,
          )}
          {rowLabels.map((label, row) =>
            label ? (
              <text key={`r${row}`} x={labelW - 6} y={labelH + row * pitchY + cellH / 2 + 3.5} textAnchor="end" style={labelStyle}>
                {label}
              </text>
            ) : null,
          )}
          {cells}
        </svg>
      </div>
      {content && (
        <Tooltip id={cursor.id} x={anchorX} y={anchorY} width={width}>
          <div className="mb-1 font-medium text-fg">{content.title}</div>
          <TipRow label="Value" value={content.value} />
        </Tooltip>
      )}
    </div>
  );
}

/** GitHub-style: weeks across, Monday to Sunday down; days outside the first and last date of the data stay blank. */
export function CalendarHeatmap({ days, format, summary }: { days: { date: string; value: number }[]; format: (value: number) => string; summary: string }) {
  if (!days.length) return <Empty summary={summary} />;
  const values = new Map<string, number>();
  for (const day of days) values.set(day.date, (values.get(day.date) ?? 0) + day.value);
  const dates = [...values.keys()].sort();
  const first = dates[0]!;
  const last = dates.at(-1)!;
  const frame = calendarFrame(first, last);
  const max = Math.max(0, ...values.values());
  const dateAt = (col: number, row: number) => addDays(frame.start, col * 7 + row);
  const inData = (date: string) => date >= first && date <= last;

  const colLabels: (string | null)[] = [];
  let month = "";
  let labelled = -Infinity;
  for (let col = 0; col < frame.weeks; col++) {
    const monday = addDays(frame.start, col * 7);
    const starts = monday.slice(0, 7) !== month && col - labelled >= 3;
    if (starts) labelled = col;
    colLabels.push(starts ? monthName(monday) : null);
    month = monday.slice(0, 7);
  }
  const end = dayOffset(frame.start, last);

  return (
    <HeatGrid
      cols={frame.weeks}
      rows={7}
      colLabels={colLabels}
      rowLabels={WEEKDAYS.map((name, row) => (row % 2 === 0 ? name : null))}
      fill={(col, row) => {
        const date = dateAt(col, row);
        return inData(date) ? heatFill(heatLevel(values.get(date) ?? 0, max)) : null;
      }}
      tip={(col, row) => {
        const date = dateAt(col, row);
        return { title: formatDay(date), value: format(values.get(date) ?? 0) };
      }}
      start={{ col: Math.floor(end / 7), row: end % 7 }}
      square
      minCell={5}
      maxCell={13}
      summary={summary}
    />
  );
}

/** Weekday rows by hour columns; `values[row][col]`. */
export function MatrixHeatmap({
  rows,
  cols,
  values,
  format,
  summary,
}: {
  rows: string[];
  cols: string[];
  values: number[][];
  format: (value: number) => string;
  summary: string;
}) {
  const max = Math.max(0, ...values.flat());
  if (!rows.length || !cols.length || max <= 0) return <Empty summary={summary} />;
  const valueAt = (col: number, row: number) => values[row]?.[col] ?? 0;
  let peak: Cell = { col: 0, row: 0 };
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < cols.length; col++) if (valueAt(col, row) > valueAt(peak.col, peak.row)) peak = { col, row };
  }
  return (
    <HeatGrid
      cols={cols.length}
      rows={rows.length}
      colLabels={cols.map((label, index) => (index % 3 === 0 ? label : null))}
      rowLabels={rows}
      fill={(col, row) => heatFill(heatLevel(valueAt(col, row), max))}
      tip={(col, row) => ({ title: `${rows[row]} ${cols[col]}`, value: format(valueAt(col, row)) })}
      start={peak}
      square={false}
      minCell={8}
      maxCell={18}
      summary={summary}
    />
  );
}

/** Ranked by value, each bar against the top one; the share is of the whole list. */
export function HBars({ rows, format, summary }: { rows: Amount[]; format: (value: number) => string; summary: string }) {
  const ranked = [...rows].sort((a, b) => b.value - a.value);
  const total = sum(ranked.map((row) => row.value));
  const top = ranked[0]?.value ?? 0;
  const color = colorScale(ranked.map((row) => row.key));
  if (top <= 0) return <Empty summary={summary} height={40} />;
  return (
    <div role="img" aria-label={summary} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-[12px]">
      {ranked.map((row) => (
        <div key={row.key} className="contents">
          <span className="truncate text-fg" title={row.label}>
            {row.label}
          </span>
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full" style={{ width: `${(row.value / top) * 100}%`, background: color(row.key) }} />
          </div>
          <span className="whitespace-nowrap text-right font-mono tabular-nums text-fg">
            {format(row.value)} <span className="text-muted">{formatShare(total > 0 ? row.value / total : 0)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A 100% stacked bar; a segment's label is written inside it when the segment is wide enough. */
export function SplitBar({ parts, format, summary }: { parts: Amount[]; format: (value: number) => string; summary: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const cursor = useCursor(parts.length, 1, { col: 0, row: 0 });
  const color = colorScale(parts.map((part) => part.key));
  const total = sum(parts.map((part) => part.value));
  if (total <= 0) return <Empty summary={summary} height={28} />;
  let offset = 0;
  const segments = parts.map((part) => {
    const share = part.value / total;
    const segment = { ...part, share, left: offset };
    offset += share;
    return segment;
  });
  const active = segments[cursor.at.col]!;

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - box.left) / Math.max(1, box.width);
    const col = segments.findIndex((segment) => fraction < segment.left + segment.share);
    if (col >= 0) cursor.move({ col, row: 0 });
  };

  return (
    <div
      ref={ref}
      className="relative w-full rounded-md outline-none focus-visible:outline-2 focus-visible:outline-accent"
      {...cursor.frame}
      aria-label={summary}
      onPointerMove={onPointerMove}
    >
      <div className="flex h-6 gap-px overflow-hidden rounded-md">
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            className="flex min-w-0 items-center overflow-hidden whitespace-nowrap px-1.5 text-[11.5px] font-medium"
            style={{
              width: `${segment.share * 100}%`,
              background: color(segment.key),
              color: "var(--canvas)",
              opacity: cursor.shown && index !== cursor.at.col ? 0.6 : 1,
            }}
          >
            {segment.share >= 0.12 && `${segment.label} ${formatShare(segment.share)}`}
          </div>
        ))}
      </div>
      {cursor.shown && (
        <Tooltip id={cursor.id} x={(active.left + active.share / 2) * width} y={28} width={width}>
          <TipRow color={color(active.key)} label={active.label} value={format(active.value)} />
          <TipRow label="Share" value={formatShare(active.share)} />
        </Tooltip>
      )}
    </div>
  );
}

export function Sparkline({ values, summary, color = "var(--chart-1)" }: { values: number[]; summary: string; color?: string }) {
  if (values.length < 2) return <Empty summary={summary} height={28} />;
  const W = 100;
  const H = 28;
  const pad = 2;
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const line = values
    .map((value, index) => `${index ? "L" : "M"}${((index / (values.length - 1)) * W).toFixed(2)} ${(pad + (1 - (value - low) / span) * (H - 2 * pad)).toFixed(2)}`)
    .join("");
  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-7 w-full overflow-visible">
      <path d={`${line}L${W} ${H}L0 ${H}Z`} style={{ fill: color, fillOpacity: 0.14 }} />
      <path d={line} fill="none" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: color }} />
    </svg>
  );
}
