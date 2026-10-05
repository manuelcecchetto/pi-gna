// Context meter next to the send button (Codex-style ring). Hover for the details card: how full the
// window is, how far pi's auto-compaction is, session totals, and Compact now. On a touch screen (`touch`) a tap
// opens the same card as a bottom sheet.
import { FoldVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveReserveTokens } from "../../../shared/compaction";
import { type ContextLevel, cacheHitRate, lastRequestUsage, summarizeContext } from "../lib/context";
import { formatCost, formatTokens } from "../lib/format";
import type { SessionState } from "../../../shared/session-state";
import type { CompactionSettings } from "../../../shared/compaction";

const LEVEL_COLOR: Record<ContextLevel, string> = {
  unknown: "var(--faint)",
  ok: "var(--muted)",
  warn: "var(--warn)",
  high: "var(--bad)",
};

export function ContextMeter({
  session,
  compaction,
  onCompact,
  touch = false,
}: {
  session: SessionState;
  compaction: CompactionSettings;
  onCompact: () => void;
  touch?: boolean;
}) {
  const reserve = resolveReserveTokens(compaction, session.model?.provider, session.model?.id);
  const summary = summarizeContext(session.stats, reserve, session.autoCompaction ?? true);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  if (!summary) return null;

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  const color = LEVEL_COLOR[summary.level];
  const label = summary.percent === null ? "—" : `${Math.round(summary.percent)}%`;

  return (
    <div className="relative" onMouseEnter={touch ? undefined : show} onMouseLeave={touch ? undefined : hide}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={`Context usage: ${label}`}
        className={`flex items-center gap-1.5 rounded-lg px-1.5 font-mono text-[11.5px] tabular-nums hover:bg-raised ${touch ? "min-h-10 min-w-10 justify-center" : "py-1"}`}
        style={{ color }}
      >
        <Ring fraction={summary.percent === null ? null : summary.percent / 100} color={color} />
        {label}
      </button>
      {open && touch && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/50" onClick={() => setOpen(false)} data-testid="context-sheet">
          <div
            className="rounded-t-2xl border-t border-line-strong bg-panel p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-[14px]"
            onClick={(event) => event.stopPropagation()}
          >
            <ContextCard session={session} summary={summary} onCompact={() => { setOpen(false); onCompact(); }} touch />
          </div>
        </div>
      )}
      {open && !touch && <ContextCard session={session} summary={summary} onCompact={onCompact} />}
    </div>
  );
}

function Ring({ fraction, color }: { fraction: number | null; color: string }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" className="-rotate-90" aria-hidden>
      <circle cx="8.5" cy="8.5" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2.2" strokeDasharray={fraction === null ? "2 2.2" : undefined} />
      {fraction !== null && (
        <circle
          cx="8.5"
          cy="8.5"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.02, Math.min(1, fraction)) * c} ${c}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      )}
    </svg>
  );
}

function ContextCard({
  session,
  summary,
  onCompact,
  touch = false,
}: {
  session: SessionState;
  summary: NonNullable<ReturnType<typeof summarizeContext>>;
  onCompact: () => void;
  touch?: boolean;
}) {
  const stats = session.stats;
  const busy = session.running || Boolean(session.compacting) || session.phase !== "ready";
  const color = LEVEL_COLOR[summary.level];
  const marker = summary.compactAt !== null ? (summary.compactAt / summary.window) * 100 : null;
  return (
    <div className={touch ? "text-[13.5px]" : "absolute right-0 bottom-full z-30 mb-2 w-80 rounded-xl border border-line-strong bg-panel p-3.5 text-[12.5px] shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]"}>
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-fg">Context window</span>
        <span className="tabular-nums text-muted">
          {summary.percent === null ? "unknown" : `${Math.round(summary.percent)}% used · ${Math.round(100 - summary.percent)}% left`}
        </span>
      </div>

      <div className="relative mt-2.5 h-1.5 rounded-full bg-raised">
        {summary.percent !== null && (
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${summary.percent}%`, background: color }} />
        )}
        {marker !== null && <div title="Auto-compaction" className="absolute -top-1 h-3.5 w-px bg-fg/70" style={{ left: `${marker}%` }} />}
      </div>

      <div className="mt-2.5 flex flex-col gap-1 text-muted">
        <Row label="In context" value={summary.used === null ? "until the next response" : `${formatTokens(summary.used)} / ${formatTokens(summary.window)} tokens`} />
        <Row label="Cache hit" value={cacheLabel(cacheHitRate(lastRequestUsage(session.items)), cacheHitRate(stats?.tokens))} />
        {summary.compactAt !== null ? (
          <Row
            label="Auto-compacts at"
            value={`${formatTokens(summary.compactAt)}${summary.left !== null ? ` · ${formatTokens(summary.left)} to go` : ""}`}
          />
        ) : (
          <Row label="Auto-compaction" value="off" />
        )}
      </div>

      {stats && (
        <>
          <div className="dashed-t mt-3 grid pt-2.5 grid-cols-2 gap-x-4 gap-y-1 text-muted">
            <Row label="Input" value={formatTokens(stats.tokens.input)} />
            <Row label="Output" value={formatTokens(stats.tokens.output)} />
            <Row label="Cache read" value={formatTokens(stats.tokens.cacheRead)} />
            <Row label="Cache write" value={formatTokens(stats.tokens.cacheWrite)} />
            <Row label="Tool calls" value={String(stats.toolCalls)} />
            {stats.cost > 0 && <Row label="Cost" value={formatCost(stats.cost)} />}
          </div>
        </>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={onCompact}
        title={session.running ? "Available when pi is idle" : "Summarize older messages now (/compact)"}
        className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 text-fg enabled:hover:bg-raised disabled:opacity-40 ${touch ? "min-h-11 text-[14px]" : "py-1.5 text-[12.5px]"}`}
      >
        <FoldVertical size={13} />
        {session.compacting ? "Compacting…" : "Compact now"}
      </button>
    </div>
  );
}

/** "99% last · 98% session": the last request shows whether the cache is warm right now. */
function cacheLabel(last: number | null, session: number | null): string {
  const pct = (rate: number) => `${Math.round(rate * 100)}%`;
  const parts = [last !== null ? `${pct(last)} last` : "", session !== null ? `${pct(session)} session` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className="font-mono text-[11.5px] text-fg tabular-nums">{value}</span>
    </div>
  );
}
