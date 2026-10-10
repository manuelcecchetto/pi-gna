import { useState, type ReactNode } from "react";
import type { UsageReport } from "../../../shared/usage";
import { formatCompact } from "../lib/format";
import { billedTokens, hoursOf, percentOf, usd } from "../lib/usage-view";
import { Info } from "./icons";
import { Card } from "./SettingsControls";
import { Popover } from "./primitives";

const count = (value: number) => value.toLocaleString();

function Stat({ label, value, title, hint, detail }: { label: ReactNode; value: ReactNode; title?: string; hint?: string; detail?: ReactNode }) {
  return (
    <div
      tabIndex={detail ? 0 : undefined}
      className="group relative flex min-w-0 flex-col gap-0.5 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="flex min-h-8 items-start gap-1 text-[12px] leading-4 text-muted">{label}</span>
      <span title={title} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[20px] leading-tight font-medium tabular-nums text-fg">
        {value}
      </span>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
      {detail && (
        <div className="pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-60 rounded-lg border border-line-strong bg-raised p-2.5 text-[12px] leading-5 text-fg shadow-[0_12px_32px_-12px_rgb(0_0_0/0.5)] group-hover:block group-focus:block">
          {detail}
        </div>
      )}
    </div>
  );
}

function BreakdownRow({ label, value, total }: { label: string; value: number; total?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 whitespace-nowrap ${total ? "mt-1 border-t border-line pt-1 font-medium" : ""}`}>
      <span className="text-muted">{label}</span>
      <span className="font-mono tabular-nums">{count(value)}</span>
    </div>
  );
}

function SubscriptionInfo() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="About the estimate"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="rounded text-faint hover:text-fg"
      >
        <Info size={13} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="top-full left-0 mt-1.5 w-64 p-3 text-[12px] leading-5 font-normal text-muted">
        Subscriptions bill a flat fee, not per token. Their runs record no cost, so the recorded figure is low. The estimate prices the same tokens
        at the API's list rates: what they would cost on the API, not what you pay. Subscription limits are not modelled.
      </Popover>
    </span>
  );
}

export function OverviewPanel({ report }: { report: UsageReport }) {
  const { totals, models } = report;
  const { tokens, cost } = totals;
  const top = models[0];
  return (
    <Card title="Overview">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-3 py-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Tokens"
          value={formatCompact(billedTokens(tokens))}
          hint="input, output and cache"
          detail={
            <div className="flex flex-col">
              <BreakdownRow label="Input" value={tokens.input} />
              <BreakdownRow label="Output" value={tokens.output} />
              <BreakdownRow label="of which reasoning" value={tokens.reasoning} />
              <BreakdownRow label="Cache read" value={tokens.cacheRead} />
              <BreakdownRow label="Cache write" value={tokens.cacheWrite} />
              <BreakdownRow label="Billed" value={billedTokens(tokens)} total />
            </div>
          }
        />
        <Stat
          label={
            <>
              API-equivalent, list prices <SubscriptionInfo />
            </>
          }
          value={
            <>
              {usd(cost.estimated)}
              <span className="whitespace-nowrap text-[12px] font-normal text-faint">recorded {usd(cost.recorded)}</span>
            </>
          }
        />
        <Stat label="Turns" value={count(totals.turns)} hint="assistant replies" />
        <Stat label="Sessions" value={count(totals.sessions)} hint="files, incl. subagent runs" />
        <Stat label="Prompts" value={count(totals.prompts)} hint={`${count(totals.abortedPrompts)} aborted`} />
        <Stat label="Active time" value={hoursOf(totals.activeMs)} hint="idle gaps not counted" />
        <Stat label="Cache hit" value={percentOf(totals.cacheHitRate)} hint="of input read from cache" />
        <Stat label="Errors" value={count(totals.errorTurns)} hint="turns with an error" />
        <Stat label="Top model" value={<span className="truncate">{top?.model ?? "None"}</span>} title={top && `${top.provider}/${top.model}`} hint={top && `${percentOf(top.share)} of billed tokens`} />
        <Stat label="Streak" value={`${totals.currentStreak} days`} hint={`longest ${totals.longestStreak} days`} />
      </div>
      {cost.unpricedTurns > 0 && (
        <p className="px-3 py-2.5 text-[12px] leading-5 text-faint">
          {count(cost.unpricedTurns)} turns ({percentOf(cost.unpricedShare)} of billed tokens) use a model with no list price. They are left out of the
          estimate, not guessed.
        </p>
      )}
    </Card>
  );
}
