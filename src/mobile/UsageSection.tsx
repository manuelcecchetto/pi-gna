// Settings > Usage on the phone: the Mac's usage report (usage.get) as headline figures, the daily bars, the models and the
// top projects, with the range and source as segmented controls. Read-only: the Mac reads its session files, the phone shows the result.
import { type ReactNode, useEffect, useState } from "react";
import { Figure, Legend, type Series, StackedBars } from "../renderer/src/components/Charts";
import { formatStamp, formatTokens } from "../renderer/src/lib/format";
import { useStore } from "../renderer/src/lib/store";
import { USAGE_DEFAULT_FILTERS, type UsageFilters, USAGE_SOURCES } from "../renderer/src/lib/usage-filters";
import { billedTokens, hoursOf, modelDayBars, percentOf, usd } from "../renderer/src/lib/usage-view";
import { type UsageProgress, type UsageQuery, USAGE_RANGES, type UsageReport } from "../shared/usage";
import type { HostClient } from "./client/host-client";
import { changeError, USAGE_RANGE_LABELS, USAGE_SOURCE_LABELS, usageProgressText } from "./settings-data";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MODELS_SHOWN = 6;
const PROJECTS_SHOWN = 5;

/** The report for a query: the last one stays while a new one loads (`pending`). */
function useUsageReport(client: HostClient, query: UsageQuery, version: string) {
  const id = `${JSON.stringify(query)}#${version}`;
  const [state, setState] = useState<{ id?: string; report?: UsageReport; error?: string }>({});
  useEffect(() => {
    let live = true;
    client.call("usage.get", { query }).then(
      (report) => {
        if (live) setState({ id, report });
      },
      (error: unknown) => {
        if (live) setState((previous) => ({ id, report: previous.report, error: changeError(error).text }));
      },
    );
    return () => {
      live = false;
    };
  }, [client, id]);
  return { report: state.report, error: state.id === id ? state.error : undefined, pending: state.id !== id };
}

export function UsageSection({ client }: { client: HostClient }) {
  const [filters, setFilters] = useState<UsageFilters>(USAGE_DEFAULT_FILTERS);
  const [attempt, setAttempt] = useState(0);
  const progress = useStore(client.store, (s) => s.global.usageProgress);
  const revision = useStore(client.store, (s) => s.global.usageRevision ?? 0);
  const { report, error, pending } = useUsageReport(client, { range: filters.range, source: filters.source, timeZone: TIME_ZONE }, `${revision}:${attempt}`);
  return (
    <div className="flex flex-col pb-4" data-testid="usage">
      <div className="flex flex-col gap-2 px-4 pt-4">
        <Segmented testId="usage-range" label="Range" value={filters.range} options={USAGE_RANGES} labels={USAGE_RANGE_LABELS} onChange={(range) => setFilters((f) => ({ ...f, range }))} />
        <Segmented testId="usage-source" label="Source" value={filters.source} options={USAGE_SOURCES} labels={USAGE_SOURCE_LABELS} onChange={(source) => setFilters((f) => ({ ...f, source }))} />
        {report && !error && (
          <p className="px-1 text-[12px] text-faint tabular-nums">{pending ? "Updating…" : `Updated ${formatStamp(report.meta.generatedAt)}`}</p>
        )}
      </div>
      {error ? (
        <Panel title="Could not load usage">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 text-[13px] wrap-anywhere text-muted">{error}</span>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="min-h-10 shrink-0 rounded-lg border border-line px-3 text-[14px] text-fg active:bg-raised">
              Try again
            </button>
          </div>
        </Panel>
      ) : !report ? (
        <Panel title="Reading pi's session files" note="The first load reads every session file once; later loads read only what changed.">
          <Progress progress={progress} />
        </Panel>
      ) : report.totals.turns === 0 ? (
        <Panel title="Nothing to show yet" note="Widen the range, or pick All pi to include the chats pi-gna did not start.">
          <p className="text-[13px] text-muted">{report.meta.files === 0 ? "No session files found. pi writes one per chat." : "No turns in this range and source."}</p>
        </Panel>
      ) : (
        <Report report={report} pending={pending} />
      )}
    </div>
  );
}

function Segmented<T extends string>({ testId, label, value, options, labels, onChange }: { testId: string; label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg border border-line p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          data-testid={`${testId}-${option}`}
          className={`min-h-9 min-w-0 flex-1 truncate rounded-md px-2 text-[14px] ${option === value ? "bg-raised text-fg" : "text-muted active:text-fg"}`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="px-4 pt-4">
      <h2 className="mb-1.5 px-1 text-[12px] font-medium tracking-wide text-faint uppercase">{title}</h2>
      <div className="rounded-xl border border-line px-3.5 py-3">{children}</div>
      {note && <p className="mt-1.5 px-1 text-[12px] leading-relaxed text-faint">{note}</p>}
    </section>
  );
}

function Progress({ progress }: { progress?: UsageProgress }) {
  const fraction = progress?.phase === "index" && progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="text-[12px] text-muted tabular-nums">{usageProgressText(progress)}</p>
    </div>
  );
}

/** A model's series label without its provider (`claude-bridge/claude-opus-5-5` is `claude-opus-5-5`). */
const shortSeries = (series: Series[]): Series[] => series.map((item) => ({ ...item, label: item.key.includes("/") ? item.key.slice(item.key.indexOf("/") + 1) : item.label }));

function Report({ report, pending }: { report: UsageReport; pending: boolean }) {
  const { totals } = report;
  const days = modelDayBars(report.days, "tokens");
  const models = report.models.slice(0, MODELS_SHOWN);
  const projects = [...report.projects].sort((a, b) => b.estimated - a.estimated || b.tokens - a.tokens).slice(0, PROJECTS_SHOWN);
  return (
    <div className={`transition-opacity ${pending ? "opacity-60" : ""}`} aria-busy={pending} data-testid="usage-report">
      <Panel title="Total">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4" data-testid="usage-figures">
          <Figure label="Estimated cost" value={usd(totals.cost.estimated)} hint={totals.cost.unpricedTurns > 0 ? `${totals.cost.unpricedTurns.toLocaleString()} turns unpriced` : "at list prices"} />
          <Figure label="Billed tokens" value={formatTokens(billedTokens(totals.tokens))} hint="input, output, cache" />
          <Figure label="Turns" value={totals.turns.toLocaleString()} hint={`${totals.prompts.toLocaleString()} prompts`} />
          <Figure label="Session files" value={totals.sessions.toLocaleString()} hint="incl. subagent runs" />
          <Figure label="Cache hit" value={percentOf(totals.cacheHitRate)} />
          <Figure label="Active time" value={hoursOf(totals.activeMs)} hint={`${totals.currentStreak} day streak`} />
        </div>
      </Panel>
      <Panel title="Tokens per day">
        <StackedBars series={shortSeries(days.series)} buckets={days.buckets} format={formatTokens} summary={`Tokens per day over ${report.days.length} days`} height={150} />
        <div className="mt-2">
          <Legend items={shortSeries(days.series)} />
        </div>
      </Panel>
      <Panel title="Models">
        <ul className="flex flex-col gap-3" data-testid="usage-models">
          {models.map((row) => (
            <li key={`${row.provider}/${row.model}`} className="flex flex-col gap-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] text-fg" title={`${row.provider}/${row.model}`}>{row.model}</span>
                <span className="shrink-0 text-[13px] text-muted tabular-nums">{row.priced ? usd(row.estimated) : "unpriced"}</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-sunken">
                <div className="h-full bg-accent" style={{ width: `${Math.max(row.share * 100, 1)}%` }} />
              </div>
              <span className="text-[12px] text-faint tabular-nums">
                {row.provider} · {row.turns.toLocaleString()} turns · {percentOf(row.share)} of tokens
              </span>
            </li>
          ))}
        </ul>
        {report.models.length > MODELS_SHOWN && <p className="mt-3 text-[12px] text-faint">{report.models.length - MODELS_SHOWN} more on the Mac</p>}
      </Panel>
      {projects.length > 0 && (
        <Panel title="Top projects">
          <ul className="flex flex-col gap-3" data-testid="usage-projects">
            {projects.map((row) => (
              <li key={row.project} className="flex min-w-0 items-baseline gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-fg" title={row.project}>{row.label}</div>
                  <div className="text-[12px] text-faint tabular-nums">{row.sessions.toLocaleString()} sessions · {formatTokens(row.tokens)} tokens</div>
                </div>
                <span className="shrink-0 text-[13px] text-muted tabular-nums">{usd(row.estimated)}</span>
              </li>
            ))}
          </ul>
          {report.projects.length > PROJECTS_SHOWN && <p className="mt-3 text-[12px] text-faint">{report.projects.length - PROJECTS_SHOWN} more on the Mac</p>}
        </Panel>
      )}
    </div>
  );
}
