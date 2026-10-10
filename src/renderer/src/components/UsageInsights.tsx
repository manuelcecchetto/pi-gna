import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function InsightsPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Insights">
      <p className="px-3 py-3 text-[13px] text-muted">{report.insights.length.toLocaleString()} insights</p>
    </Card>
  );
}
