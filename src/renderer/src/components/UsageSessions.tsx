import type { SessionRow, UsageReport } from "../../../shared/usage";
import { baseName, formatCompact, formatDuration, formatStamp } from "../lib/format";
import { SURFACE_LABELS, usd } from "../lib/usage-view";
import { openSession } from "../state/app";
import { Card } from "./SettingsControls";

const ROW = "grid w-full grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-4 px-3 py-2 text-left text-[12px] tabular-nums";

function unopenableReason(row: SessionRow): string {
  return row.surface === "atp-worker" ? "ATP runs open from their plan" : "The file is no longer on disk";
}

function SessionLine({ row, project }: { row: SessionRow; project: string }) {
  const cells = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-fg">{row.title}</span>
        <span className="block truncate text-[11px] text-faint">
          {project} · {formatStamp(row.firstAt)}
        </span>
      </span>
      <span className="whitespace-nowrap rounded-md border border-line px-1.5 py-px text-[11px] text-muted">{SURFACE_LABELS[row.surface]}</span>
      <span className="text-right text-fg">{usd(row.estimated)}</span>
      <span className="text-right text-fg">{formatCompact(row.tokens)}</span>
      <span className="text-right text-muted">{formatDuration(row.activeMs)}</span>
    </>
  );
  if (!row.openable) {
    return (
      <li className={ROW} title={unopenableReason(row)}>
        {cells}
      </li>
    );
  }
  return (
    <li>
      <button type="button" onClick={() => openSession({ path: row.path, cwd: row.cwd, title: row.title })} className={`${ROW} hover:bg-raised`}>
        {cells}
      </button>
    </li>
  );
}

export function SessionsPanel({ report }: { report: UsageReport }) {
  const labels = new Map(report.projects.map((row) => [row.project, row.label]));
  return (
    <Card
      title="Sessions"
      note="Top 10 by estimated cost, subagents rolled in. Click a chat to open it; ATP runs open from their plan, and a file gone from disk cannot be opened."
    >
      <ul className="divide-y divide-line">
        {report.sessions.map((row) => (
          <SessionLine key={row.id} row={row} project={labels.get(row.project) ?? baseName(row.project)} />
        ))}
      </ul>
    </Card>
  );
}
