import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function ModelsPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Models">
      <p className="px-3 py-3 text-[13px] text-muted">{report.models.length.toLocaleString()} models</p>
    </Card>
  );
}
