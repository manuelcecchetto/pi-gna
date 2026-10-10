import { INSIGHT_MIN_SHARE, type UsageReport } from "../../../shared/usage";
import { insightFigures, INSIGHT_LABELS, percentOf } from "../lib/usage-view";
import { Card } from "./SettingsControls";

export function InsightsPanel({ report }: { report: UsageReport }) {
  if (report.insights.length === 0) return null;
  return (
    <Card title="Insights" note={`Behaviours that make up ${percentOf(INSIGHT_MIN_SHARE)} or more of their base. Each one's tip is what to change.`}>
      {report.insights.map((insight) => {
        const figures = insightFigures(insight);
        return (
          <article key={insight.id} className="flex flex-col gap-1 px-3 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-[13px] font-medium text-fg">{INSIGHT_LABELS[insight.id]}</h3>
              <span className="text-right text-[13px] tabular-nums">
                <span className="font-medium text-fg">{figures.value}</span>{" "}
                <span className="whitespace-nowrap text-[12px] text-faint">threshold {figures.threshold}</span>
              </span>
            </div>
            <p className="text-[12px] tabular-nums text-muted">{figures.detail}</p>
            <p className="text-[12px] leading-5 text-faint">{insight.tip}</p>
          </article>
        );
      })}
    </Card>
  );
}
