import type { ToolRow, UsageReport } from "../../../shared/usage";
import { percentOf, plural, TOOL_BARS_MAX, toolBars, toolSummary } from "../lib/usage-view";
import { HBars } from "./Charts";
import { Card } from "./SettingsControls";

const count = (value: number) => value.toLocaleString();
const callsOf = (rows: ToolRow[]) => rows.reduce((total, row) => total + row.calls, 0);

export function ToolsPanel({ report }: { report: UsageReport }) {
  const { tools, totals } = report;
  const byName = new Map(tools.rows.map((row) => [row.name, row]));
  const otherCalls = totals.toolCalls - callsOf(tools.rows.slice(0, TOOL_BARS_MAX));
  return (
    <Card
      title="Tools"
      note="Mean duration only: the facts keep each tool's summed time, so there is no median or p90. Calls in one message start together, so a duration is an upper bound."
    >
      <section className="flex flex-col gap-3 px-3 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg">Calls by tool</h3>
          <span className="text-[12px] text-muted">
            {count(totals.toolCalls)} calls, {count(tools.nestedCalls)} made inside codemode runs
          </span>
        </div>
        <HBars
          rows={toolBars(tools.rows)}
          format={(value) => plural(value, "call")}
          summary={`Calls per tool, ${count(totals.toolCalls)} in all`}
          aside={(row) => {
            const tool = byName.get(row.key);
            return tool ? toolSummary(tool) : null;
          }}
        />
        {otherCalls > 0 && <p className="text-[12px] text-faint">{count(otherCalls)} calls from other tools, not shown</p>}
      </section>
      <section className="flex flex-col gap-2 px-3 py-3">
        <h3 className="text-[13px] font-medium text-fg">Most failing</h3>
        {tools.topFailing.length === 0 ? (
          <p className="text-[12px] text-muted">No tool call failed in this range.</p>
        ) : (
          <ol className="flex flex-col gap-1.5 text-[12px]">
            {tools.topFailing.map((row) => (
              <li key={row.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4">
                <span className="truncate font-mono text-fg">{row.name}</span>
                <span className="whitespace-nowrap text-right tabular-nums text-fg">
                  {count(row.errors)} of {count(row.calls)}
                </span>
                <span className="w-14 text-right tabular-nums text-muted">{percentOf(row.errorRate)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Card>
  );
}
