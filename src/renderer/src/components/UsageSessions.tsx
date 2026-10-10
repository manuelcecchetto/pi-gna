import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function SessionsPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Sessions">
      <p className="px-3 py-3 text-[13px] text-muted">{report.sessions.length.toLocaleString()} sessions in the top list</p>
    </Card>
  );
}
