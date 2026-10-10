import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function OverviewPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Overview">
      <p className="px-3 py-3 text-[13px] text-muted">
        {report.totals.turns.toLocaleString()} turns in {report.totals.sessions.toLocaleString()} sessions
      </p>
    </Card>
  );
}
