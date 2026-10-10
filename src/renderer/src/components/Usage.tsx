// Settings > Usage: the filter bar, the report and its panels (one file each, UsageOverview.tsx and the rest). Loaded on
// first use from Settings.tsx, so the startup bundle does not grow.
import { RefreshCw, TriangleAlert } from "./icons";
import { useEffect, useMemo, useState } from "react";
import { type ProjectRow, USAGE_RANGES, type UsageProgress, type UsageQuery, type UsageRange, type UsageReport, type UsageSource } from "../../../shared/usage";
import { baseName, formatBytes } from "../lib/format";
import { loadUsageFilters, saveUsageFilters, type UsageFilters, USAGE_SOURCES, usageQueries } from "../lib/usage-filters";
import { toast } from "../state/app";
import { ActivityPanel } from "./UsageActivity";
import { Button, Card, Segmented } from "./SettingsControls";
import { HealthPanel } from "./UsageHealth";
import { InsightsPanel } from "./UsageInsights";
import { ModelsPanel } from "./UsageModels";
import { OverviewPanel } from "./UsageOverview";
import { ProjectsPanel } from "./UsageProjects";
import { SessionsPanel } from "./UsageSessions";
import { ToolsPanel } from "./UsageTools";

const RANGE_LABELS: Record<UsageRange, string> = { "7d": "7d", "14d": "14d", "30d": "30d", "90d": "90d", all: "All" };
const SOURCE_LABELS: Record<UsageSource, string> = { pigna: "pi-gna", all: "All pi sessions" };
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const clockOf = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** The report for a query, with a reload counter: the last report stays while a new one loads (`pending`). */
function useReport(query: UsageQuery | undefined, reload: number) {
  const id = query && `${JSON.stringify(query)}#${reload}`;
  const [state, setState] = useState<{ id?: string; report?: UsageReport; error?: string }>({});
  useEffect(() => {
    if (!query || !id) return;
    let live = true;
    window.studio.usage.get(query).then(
      (report) => {
        if (live) setState({ id, report });
      },
      (error: unknown) => {
        if (live) setState((previous) => ({ id, report: previous.report, error: messageOf(error) }));
      },
    );
    return () => {
      live = false;
    };
  }, [id]);
  return {
    report: state.report,
    error: id !== undefined && state.id === id ? state.error : undefined,
    pending: id !== undefined && state.id !== id,
  };
}

export function UsageSection() {
  const [filters, setFilters] = useState<UsageFilters>(loadUsageFilters);
  const [reload, setReload] = useState(0);
  const [progress, setProgress] = useState<UsageProgress>();
  const [refreshing, setRefreshing] = useState(false);
  const queries = useMemo(() => usageQueries(filters, TIME_ZONE), [filters]);
  const base = useReport(queries.base, reload);
  const scoped = useReport(queries.scoped, reload);
  const current = queries.scoped ? scoped : base;
  const report = current.report ?? base.report;

  useEffect(() => saveUsageFilters(filters), [filters]);
  useEffect(() => window.studio.usage.onProgress((next) => setProgress(next.phase === "done" ? undefined : next)), []);

  const update = (patch: Partial<UsageFilters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const refresh = () => {
    setRefreshing(true);
    window.studio.usage
      .refresh()
      .then(
        () => setReload((count) => count + 1),
        (error: unknown) => toast(`Could not refresh usage: ${messageOf(error)}`, "error"),
      )
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={filters.range} options={USAGE_RANGES} labels={RANGE_LABELS} onChange={(range) => update({ range })} />
        <Segmented value={filters.source} options={USAGE_SOURCES} labels={SOURCE_LABELS} onChange={(source) => update({ source })} />
        <ProjectPicker value={filters.project} projects={base.report?.projects ?? []} onChange={(project) => update({ project })} />
        <div className="ml-auto flex items-center gap-2 text-[12px] text-faint">
          {report && <span className="tabular-nums">{current.pending || base.pending ? "updating" : `updated ${clockOf(report.meta.generatedAt)}`}</span>}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="Read the session files again"
            aria-label="Refresh usage"
            className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {current.error ? (
        <ErrorState message={current.error} onRetry={() => setReload((count) => count + 1)} />
      ) : report ? (
        <Report report={report} pending={current.pending || base.pending} />
      ) : (
        <LoadingState progress={progress} />
      )}
    </div>
  );
}

function ProjectPicker({ value, projects, onChange }: { value?: string; projects: ProjectRow[]; onChange: (project: string | undefined) => void }) {
  return (
    <select
      aria-label="Project"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}
      className="max-w-64 truncate rounded-lg border border-line bg-panel px-2 py-1 text-[12px] text-fg outline-none"
    >
      <option value="">All projects</option>
      {value !== undefined && !projects.some((row) => row.project === value) && <option value={value}>{baseName(value)}</option>}
      {projects.map((row) => (
        <option key={row.project} value={row.project} title={row.project}>
          {row.label}
        </option>
      ))}
    </select>
  );
}

function LoadingState({ progress }: { progress?: UsageProgress }) {
  const indexing = progress?.phase === "index" ? progress : undefined;
  const fraction = indexing && indexing.total > 0 ? indexing.done / indexing.total : 0;
  return (
    <Card title="Reading pi's session files" note="The first load reads every session file once; later loads read only what changed.">
      <div className="flex flex-col gap-2 px-3 py-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${fraction * 100}%` }} />
        </div>
        <p className="text-[12px] text-muted tabular-nums">
          {indexing
            ? `${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()} files · ${formatBytes(indexing.bytes ?? 0)} of ${formatBytes(indexing.totalBytes ?? 0)}`
            : progress?.phase === "scan"
              ? "Listing session files…"
              : "Preparing the report…"}
        </p>
      </div>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card title="Could not load usage">
      <div className="flex items-center gap-3 px-3 py-3">
        <TriangleAlert size={16} className="shrink-0 text-bad" />
        <span className="min-w-0 flex-1 text-[13px] text-muted">{message}</span>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </Card>
  );
}

function Report({ report, pending }: { report: UsageReport; pending: boolean }) {
  if (report.totals.turns === 0) {
    return (
      <Card title="Nothing to show yet" note="Widen the range, or pick All pi sessions to include the chats pi-gna did not start.">
        <p className="px-3 py-3 text-[13px] text-muted">
          {report.meta.files === 0 ? "No session files found. pi writes one per chat." : "No turns in this range and source."}
        </p>
      </Card>
    );
  }
  return (
    <div className={`grid gap-4 transition-opacity md:grid-cols-2 ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <div className="md:col-span-2">
        <OverviewPanel report={report} />
      </div>
      <div className="md:col-span-2">
        <ActivityPanel report={report} />
      </div>
      <ModelsPanel report={report} />
      <ProjectsPanel report={report} />
      <SessionsPanel report={report} />
      <ToolsPanel report={report} />
      <HealthPanel report={report} />
      <InsightsPanel report={report} />
    </div>
  );
}
