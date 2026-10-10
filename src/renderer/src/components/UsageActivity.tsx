import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function ActivityPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Activity">
      <p className="px-3 py-3 text-[13px] text-muted">{report.days.length.toLocaleString()} days in the series</p>
    </Card>
  );
}
