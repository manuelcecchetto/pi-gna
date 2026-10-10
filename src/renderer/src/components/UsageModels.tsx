import { useState } from "react";
import type { ModelRow, UsageReport } from "../../../shared/usage";
import { formatCompact } from "../lib/format";
import { billedTokens, type ModelSort, type ModelSortKey, percentOf, sortModels, usd } from "../lib/usage-view";
import { ArrowDown, ArrowUp } from "./icons";
import { Card } from "./SettingsControls";

const COLUMNS: { key: ModelSortKey; label: string }[] = [
  { key: "model", label: "Model" },
  { key: "turns", label: "Turns" },
  { key: "tokens", label: "Tokens" },
  { key: "estimated", label: "Est. cost" },
  { key: "share", label: "Share" },
  { key: "cacheHitRate", label: "Cache hit" },
];

const count = (value: number) => value.toLocaleString();
const tokenTip = (tokens: ModelRow["tokens"]) =>
  `Input ${count(tokens.input)} · output ${count(tokens.output)} · cache read ${count(tokens.cacheRead)} · cache write ${count(tokens.cacheWrite)}`;

export function ModelsPanel({ report }: { report: UsageReport }) {
  const [sort, setSort] = useState<ModelSort>({ key: "estimated", desc: true });
  const choose = (key: ModelSortKey) =>
    setSort((current) => (current.key === key ? { key, desc: !current.desc } : { key, desc: key !== "model" }));
  return (
    <Card title="Models" note="Estimated cost is at list price; an unpriced model is left out of it. Share is of billed tokens.">
      <div className="overflow-x-auto px-3 py-3">
        <table className="w-full min-w-[36rem] border-collapse text-[12px] tabular-nums">
          <thead>
            <tr className="text-muted">
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    aria-sort={active ? (sort.desc ? "descending" : "ascending") : undefined}
                    className={`py-1.5 font-normal ${column.key === "model" ? "pr-3 text-left" : "px-3 text-right"}`}
                  >
                    <button
                      type="button"
                      onClick={() => choose(column.key)}
                      className={`inline-flex items-center gap-1 hover:text-fg ${active ? "text-fg" : ""}`}
                    >
                      {column.label}
                      {active && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortModels(report.models, sort).map((row) => (
              <tr key={`${row.provider}/${row.model}`} className="border-t border-line text-fg">
                <td className="py-1.5 pr-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate" title={`${row.provider}/${row.model}`}>
                      <span className="text-muted">{row.provider}/</span>
                      {row.model}
                    </span>
                    {!row.priced && <span className="shrink-0 rounded-md border border-line px-1.5 py-px text-[10.5px] text-warn">unpriced</span>}
                  </div>
                </td>
                <td className="px-3 text-right">{count(row.turns)}</td>
                <td className="px-3 text-right" title={tokenTip(row.tokens)}>
                  {formatCompact(billedTokens(row.tokens))}
                </td>
                <td className="px-3 text-right">
                  {row.priced ? usd(row.estimated) : <span className="text-faint" title="No list price for this model">—</span>}
                </td>
                <td className="px-3">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${row.share * 100}%` }} />
                    </div>
                    <span className="w-12 text-right">{percentOf(row.share)}</span>
                  </div>
                </td>
                <td className="px-3 text-right">{percentOf(row.cacheHitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
