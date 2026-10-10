import type { UsageReport, WindowRow } from "../../../shared/usage";
import { formatCompact, formatStamp } from "../lib/format";
import { usd } from "../lib/usage-view";
import { Figure } from "./Charts";
import { Card } from "./SettingsControls";

const count = (value: number) => value.toLocaleString();
const burn = (perMinute: number) => `${formatCompact(Math.round(perMinute))}/min`;

function CurrentWindow({ row, now }: { row: WindowRow; now: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-sunken p-3">
      <span className="text-[12px] text-muted">
        Running now, started {formatStamp(row.start, now)}, ends {formatStamp(row.end, now)}
      </span>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure label="Tokens so far" value={formatCompact(row.tokens)} hint={`${count(row.turns)} turns`} />
        <Figure label="Est. cost" value={usd(row.estimated)} hint="list prices" />
        <Figure label="Burn rate" value={burn(row.burnRate)} hint="over the time elapsed" />
        <Figure label="Sessions" value={count(row.sessions)} hint="in this window" />
      </div>
    </div>
  );
}

export function WindowsPanel({ report }: { report: UsageReport }) {
  const { windows, meta } = report;
  const now = meta.generatedAt;
  return (
    <Card
      title="5-hour windows"
      note="A window starts at a turn and runs five hours; the next starts at the first turn after it ends. Burn rate is tokens per minute over the time the window has run."
    >
      <section className="flex flex-col gap-3 px-3 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg">Busiest windows</h3>
          <span className="text-[12px] text-muted">{count(windows.count)} windows in the range</span>
        </div>
        {windows.current && <CurrentWindow row={windows.current} now={now} />}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-[12px] tabular-nums">
            <thead>
              <tr className="text-muted">
                <th className="py-1.5 pr-3 text-left font-normal">Started</th>
                <th className="px-3 py-1.5 text-left font-normal">Ends</th>
                <th className="px-3 py-1.5 text-right font-normal">Tokens</th>
                <th className="px-3 py-1.5 text-right font-normal">Est. cost</th>
                <th className="px-3 py-1.5 text-right font-normal">Turns</th>
                <th className="px-3 py-1.5 text-right font-normal">Sessions</th>
                <th className="py-1.5 pl-3 text-right font-normal">Burn rate</th>
              </tr>
            </thead>
            <tbody>
              {windows.top.map((row) => (
                <tr key={row.start} className="border-t border-line text-fg">
                  <td className="py-1.5 pr-3 text-left">
                    {formatStamp(row.start, now)}
                    {row.active && <span className="ml-2 text-accent">running</span>}
                  </td>
                  <td className="px-3 py-1.5 text-left text-muted">{formatStamp(row.end, now)}</td>
                  <td className="px-3 py-1.5 text-right">{formatCompact(row.tokens)}</td>
                  <td className="px-3 py-1.5 text-right">{usd(row.estimated)}</td>
                  <td className="px-3 py-1.5 text-right">{count(row.turns)}</td>
                  <td className="px-3 py-1.5 text-right">{count(row.sessions)}</td>
                  <td className="py-1.5 pl-3 text-right">{burn(row.burnRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Card>
  );
}
