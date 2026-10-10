import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function ToolsPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Tools">
      <p className="px-3 py-3 text-[13px] text-muted">{report.totals.toolCalls.toLocaleString()} tool calls</p>
    </Card>
  );
}
