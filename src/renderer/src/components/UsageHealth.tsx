import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function HealthPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Health">
      <p className="px-3 py-3 text-[13px] text-muted">{report.totals.errorTurns.toLocaleString()} error turns</p>
    </Card>
  );
}
