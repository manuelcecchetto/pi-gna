import { useState } from "react";
import type { UsageReport } from "../../../shared/usage";
import { formatCompact } from "../lib/format";
import { SURFACE_LABELS, surfaceParts, usd } from "../lib/usage-view";
import { Legend, SplitBar } from "./Charts";
import { Card, Segmented } from "./SettingsControls";

type SplitMeasure = "tokens" | "cost";
const SPLIT_MEASURES: SplitMeasure[] = ["tokens", "cost"];
const MEASURE_LABELS: Record<SplitMeasure, string> = { tokens: "Tokens", cost: "Est. cost" };
const FORMAT: Record<SplitMeasure, (value: number) => string> = {
  tokens: (value) => `${formatCompact(value)} tokens`,
  cost: usd,
};
const count = (value: number) => value.toLocaleString();

export function SurfacesPanel({ report }: { report: UsageReport }) {
  const [measure, setMeasure] = useState<SplitMeasure>("tokens");
  const parts = surfaceParts(report.surfaces, measure);
  return (
    <Card title="Surfaces" note="A subagent counts with the chat that ran it. It is a row of its own only when that chat is out of the range.">
      <section className="flex flex-col gap-3 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg">Share by surface</h3>
          <Segmented value={measure} options={SPLIT_MEASURES} labels={MEASURE_LABELS} onChange={setMeasure} />
        </div>
        <SplitBar parts={parts} format={FORMAT[measure]} summary={`${MEASURE_LABELS[measure]} by surface`} />
        <Legend items={parts} />
      </section>
      <section className="overflow-x-auto px-3 py-3">
        <table className="w-full min-w-[32rem] border-collapse text-[12px] tabular-nums">
          <thead>
            <tr className="text-muted">
              <th className="py-1.5 pr-3 text-left font-normal">Surface</th>
              <th className="px-3 py-1.5 text-right font-normal">Sessions</th>
              <th className="px-3 py-1.5 text-right font-normal">Turns</th>
              <th className="px-3 py-1.5 text-right font-normal">Tokens</th>
              <th className="px-3 py-1.5 text-right font-normal">Est. cost</th>
              <th className="py-1.5 pl-3 text-right font-normal">From subagents</th>
            </tr>
          </thead>
          <tbody>
            {report.surfaces.map((row) => (
              <tr key={row.surface} className="border-t border-line text-fg">
                <td className="py-1.5 pr-3 text-left">{SURFACE_LABELS[row.surface]}</td>
                <td className="px-3 py-1.5 text-right">{count(row.sessions)}</td>
                <td className="px-3 py-1.5 text-right">{count(row.turns)}</td>
                <td className="px-3 py-1.5 text-right">{formatCompact(row.tokens)}</td>
                <td className="px-3 py-1.5 text-right">{usd(row.estimated)}</td>
                <td className="py-1.5 pl-3 text-right text-muted">{formatCompact(row.subagentTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Card>
  );
}
