import type { UsageReport } from "../../../shared/usage";
import { Card } from "./SettingsControls";

export function ProjectsPanel({ report }: { report: UsageReport }) {
  return (
    <Card title="Projects">
      <p className="px-3 py-3 text-[13px] text-muted">{report.projects.length.toLocaleString()} projects</p>
    </Card>
  );
}
