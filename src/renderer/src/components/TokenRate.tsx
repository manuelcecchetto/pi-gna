// Output speed next to the context meter: tokens per second of the response streaming now, else of the last one.
// Hover for a card charting every measured response of the session: time across, tok/s up, the line colored from
// red (slow) through orange to green (fast).
import { memo, useEffect, useId, useRef, useState } from "react";
import { formatDuration, formatTokens } from "../lib/format";
import type { Item } from "../../../shared/session-state";
import { latestRate, type RatePoint, rateHistory, rateMoving } from "../../../shared/token-rate";
import { useNow } from "./primitives";

/** Where the line turns from red to orange to green, in tok/s. */
const SLOW = 20;
const MEDIUM = 50;
const FAST = 100;

export const TokenRate = memo(function TokenRate({ items, running }: { items: Item[]; running: boolean }) {
  // Ticks while a response streams: its time runs on between stream events.
  useNow(500, running && rateMoving(items));
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const now = Date.now();
  const rate = latestRate(items, now);
  if (!rate) return null;
  const about = rate.estimated ? "~" : "";
  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <span className={`whitespace-nowrap font-mono text-[11.5px] tabular-nums ${rate.live ? "text-muted" : "text-faint"}`}>
        {about}
        {formatRate(rate.perSecond)} tok/s
      </span>
      {open && <RateCard points={rateHistory(items, now)} />}
    </div>
  );
});

export function RateCard({ points }: { points: RatePoint[] }) {
  const last = points.at(-1);
  if (!last) return null;
  const about = last.estimated ? "~" : "";
  const tokens = points.reduce((sum, point) => sum + point.tokens, 0);
  const seconds = points.reduce((sum, point) => sum + point.seconds, 0);
  return (
    <div className="absolute right-0 bottom-full z-30 mb-2 w-80 rounded-xl border border-line-strong bg-panel p-3.5 text-[12.5px] shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-fg">Output speed</span>
        <span className="font-mono text-[11.5px] tabular-nums" style={{ color: speedColor(last.perSecond) }}>
          {about}
          {formatRate(last.perSecond)} tok/s
        </span>
      </div>
      <RateChart points={points} />
      <div className="mt-2 flex flex-col gap-1 text-muted">
        <Row
          label={last.live ? "Streaming now" : "Last response"}
          value={`${about}${formatTokens(Math.round(last.tokens))} tokens in ${formatDuration(last.seconds * 1000)}`}
        />
        <Row label={`Average of ${points.length} ${points.length === 1 ? "response" : "responses"}`} value={`${formatRate(tokens / seconds)} tok/s`} />
      </div>
      {last.estimated && <p className="mt-2 text-[11.5px] text-faint">Estimated from the streamed output until the provider reports the token count.</p>}
    </div>
  );
}

const WIDTH = 290;
const HEIGHT = 96;
const PAD = { top: 6, right: 6, bottom: 16, left: 28 };

function RateChart({ points }: { points: RatePoint[] }) {
  const gradient = useId();
  const first = points[0]!;
  const last = points.at(-1)!;
  const top = niceMax(Math.max(...points.map((point) => point.perSecond)));
  const span = last.at - first.at;
  // Seconds only when the whole chart fits in a few minutes, where minutes alone would repeat.
  const time = (at: number) => clock(at, span < 5 * 60_000);
  const { offsets, gaps } = squeezeIdle(points);
  const width = offsets.at(-1)!;
  const xs = offsets.map((offset) => (width > 0 ? PAD.left + (offset / width) * (WIDTH - PAD.left - PAD.right) : (PAD.left + WIDTH - PAD.right) / 2));
  const y = (perSecond: number) => HEIGHT - PAD.bottom - (perSecond / top) * (HEIGHT - PAD.top - PAD.bottom);
  const base = y(0);
  // One stretch of line per run of work: an idle gap breaks it.
  const runs = [0, ...gaps.map((gap) => gap.after + 1)].map((from, i, starts) => xs.slice(from, starts[i + 1] ?? xs.length).map((px, j) => [px, y(points[from + j]!.perSecond)] as const));
  const line = runs.map((run) => run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("")).join("");
  const area = runs
    .filter((run) => run.length > 1)
    .map((run) => `${run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("")}L${run.at(-1)![0].toFixed(1)},${base}L${run[0]![0].toFixed(1)},${base}Z`)
    .join("");
  // Colored by speed, not by position: the stops sit at fixed tok/s, so a slow response reads red at any scale.
  const stop = (perSecond: number) => Math.min(1, perSecond / FAST);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="mt-2.5 block w-full" role="img" aria-label="Output speed of each response over time">
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={base} y2={y(FAST)}>
          <stop offset={stop(SLOW)} stopColor="var(--bad)" />
          <stop offset={stop(MEDIUM)} stopColor="var(--warn)" />
          <stop offset={1} stopColor="var(--ok)" />
        </linearGradient>
      </defs>
      {[0, top / 2, top].map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeDasharray={tick ? "2 3" : undefined} />
          <text x={PAD.left - 5} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-faint font-mono text-[9.5px]">
            {Math.round(tick)}
          </text>
        </g>
      ))}
      {gaps.map((gap) => {
        const mid = (xs[gap.after]! + xs[gap.after + 1]!) / 2;
        return (
          <line key={gap.after} x1={mid} x2={mid} y1={PAD.top} y2={base} stroke="var(--line-strong)" strokeDasharray="1 2.5">
            <title>{`Idle ${formatDuration(gap.ms)}`}</title>
          </line>
        );
      })}
      {area && <path d={area} fill={`url(#${gradient})`} opacity={0.15} />}
      <path d={line} fill="none" stroke={`url(#${gradient})`} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, i) => (
        <circle key={point.at} cx={xs[i]} cy={y(point.perSecond)} r={points.length > 40 ? 1.5 : 2.5} fill={speedColor(point.perSecond)}>
          <title>{`${clock(point.at, true)} · ${point.estimated ? "~" : ""}${formatRate(point.perSecond)} tok/s, ${formatTokens(Math.round(point.tokens))} tokens in ${formatDuration(point.seconds * 1000)}`}</title>
        </circle>
      ))}
      <text x={PAD.left} y={HEIGHT - 3} className="fill-faint font-mono text-[9.5px]">
        {time(first.at)}
      </text>
      {span > 0 && (
        <text x={WIDTH - PAD.right} y={HEIGHT - 3} textAnchor="end" className="fill-faint font-mono text-[9.5px]">
          {last.live ? "now" : time(last.at)}
        </text>
      )}
    </svg>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className="font-mono text-[11.5px] text-fg tabular-nums">{value}</span>
    </div>
  );
}

/** Pauses longer than this are drawn as a short gap, so a chat picked up hours later still shows its work. */
const IDLE = 5 * 60_000;

/**
 * Each point's place on the time axis (ms of the chart's own time) with idle pauses squeezed to a small share of the
 * active time, and where the pauses fall (after the point at `after`, `ms` long).
 */
function squeezeIdle(points: RatePoint[]): { offsets: number[]; gaps: { after: number; ms: number }[] } {
  const steps = points.slice(1).map((point, i) => point.at - points[i]!.at);
  const active = steps.filter((step) => step <= IDLE).reduce((sum, step) => sum + step, 0);
  const squeezed = active > 0 ? active * 0.06 : 1;
  const offsets = [0];
  const gaps: { after: number; ms: number }[] = [];
  steps.forEach((step, i) => {
    if (step > IDLE) gaps.push({ after: i, ms: step });
    offsets.push(offsets[i]! + (step > IDLE ? squeezed : step));
  });
  return { offsets, gaps };
}

/** The point's color on the same red, orange, green scale as the line. */
function speedColor(perSecond: number): string {
  if (perSecond < (SLOW + MEDIUM) / 2) return "var(--bad)";
  if (perSecond < (MEDIUM + FAST) / 2) return "var(--warn)";
  return "var(--ok)";
}

/** A round top for the y axis, so its ticks read as plain numbers. */
function niceMax(value: number): number {
  const step = value <= 50 ? 10 : value <= 200 ? 25 : 100;
  return Math.max(2 * step, Math.ceil((value * 1.1) / (2 * step)) * 2 * step); // even, so the midline is round too
}

function clock(at: number, seconds = false): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds && { second: "2-digit" }) });
}

function formatRate(perSecond: number): string {
  return perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond));
}
