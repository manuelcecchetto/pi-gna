import { useState } from "react";
import type { UsageReport } from "../../../shared/usage";
import { formatCompact, formatStamp } from "../lib/format";
import { plural, usd } from "../lib/usage-view";
import { type Amount, HBars } from "./Charts";
import { Card, Segmented } from "./SettingsControls";

type ProjectMeasure = "cost" | "tokens";
const MEASURES: ProjectMeasure[] = ["cost", "tokens"];
const MEASURE_LABELS: Record<ProjectMeasure, string> = { cost: "Est. cost", tokens: "Tokens" };
const FORMAT: Record<ProjectMeasure, (value: number) => string> = {
  cost: usd,
  tokens: (value) => `${formatCompact(value)} tokens`,
};
const PROJECT_BARS_MAX = 12;

export function ProjectsPanel({ report, onProject }: { report: UsageReport; onProject: (project: string) => void }) {
  const [measure, setMeasure] = useState<ProjectMeasure>("cost");
  const byKey = new Map(report.projects.map((row) => [row.project, row]));
  const bars: Amount[] = report.projects
    .map((row) => ({ key: row.project, label: row.label, value: measure === "cost" ? row.estimated : row.tokens }))
    .sort((a, b) => b.value - a.value)
    .slice(0, PROJECT_BARS_MAX);
  const hidden = report.projects.length - bars.length;
  return (
    <Card title="Projects" note="Click a project to show only its usage.">
      <section className="flex flex-col gap-3 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg">Share by project</h3>
          <Segmented value={measure} options={MEASURES} labels={MEASURE_LABELS} onChange={setMeasure} />
        </div>
        <HBars
          rows={bars}
          format={FORMAT[measure]}
          summary={`${MEASURE_LABELS[measure]} by project`}
          aside={(bar) => {
            const row = byKey.get(bar.key);
            return row ? `${plural(row.sessions, "session")} · ${formatStamp(row.lastAt)}` : null;
          }}
          onSelect={(bar) => onProject(bar.key)}
        />
        {hidden > 0 && <p className="text-[12px] text-faint">{plural(hidden, "more project")} not shown</p>}
      </section>
    </Card>
  );
}
