import type { ReactNode } from "react";
import type { UsageReport } from "../../../shared/usage";
import { formatCompact } from "../lib/format";
import { CONTEXT_BIN_LABELS, ERROR_LABELS, labelledCounts, percentOf, plural, STEP_BIN_LABELS, STOP_LABELS } from "../lib/usage-view";
import { Figure, HBars, Histogram } from "./Charts";
import { Card } from "./SettingsControls";

const count = (value: number) => value.toLocaleString();

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
        <span className="text-[12px] text-faint">{hint}</span>
      </div>
      {children}
    </section>
  );
}

export function HealthPanel({ report }: { report: UsageReport }) {
  const { health, totals } = report;
  const compactionsPerSession = totals.sessions === 0 ? 0 : health.compactions / totals.sessions;
  const steps = STEP_BIN_LABELS.map((label, index) => ({ label, value: health.promptSteps[index] ?? 0 }));
  const context = CONTEXT_BIN_LABELS.map((label, index) => ({ label, value: health.contextHist[index] ?? 0 }));
  const runs = Object.entries(health.subagentRuns).filter(([, runCount]) => runCount > 0);
  return (
    <Card title="Health" note="Totals for the range. The facts are kept per session file, so there is no time series.">
      <section className="grid grid-cols-2 gap-x-6 gap-y-4 px-3 py-3 sm:grid-cols-4">
        <Figure label="Abort rate" value={percentOf(health.abortRate)} hint={`${count(health.abortedPrompts)} of ${count(health.prompts)} prompts`} />
        <Figure label="Steps per prompt" value={health.stepsPerPrompt.toFixed(1)} hint="assistant turns" />
        <Figure label="Tool calls per prompt" value={health.toolCallsPerPrompt.toFixed(1)} hint={`${count(totals.toolCalls)} calls in all`} />
        <Figure
          label="Compactions per session"
          value={compactionsPerSession.toFixed(2)}
          hint={`${count(health.compactions)} in ${count(health.compactingSessions)} of ${count(totals.sessions)} sessions`}
        />
      </section>
      <Section title="Stop reasons" hint="per assistant turn">
        <HBars rows={labelledCounts(health.stops, STOP_LABELS)} format={(value) => plural(value, "turn")} summary="Turns by stop reason" />
      </Section>
      <Section title="Errors" hint="per turn, by category">
        <HBars rows={labelledCounts(health.errors, ERROR_LABELS)} format={(value) => plural(value, "turn")} summary="Error turns by category" />
      </Section>
      <Section title="Prompts by steps" hint="a step is one assistant turn">
        <Histogram bins={steps} format={(value) => plural(value, "prompt")} summary="Prompts by number of steps" />
      </Section>
      <Section title="Context size" hint="input per turn, cache included">
        <Histogram bins={context} format={(value) => plural(value, "turn")} summary="Turns by input size, in tokens" />
      </Section>
      <Section title="Context and subagents" hint={`${count(health.compactions)} compactions, ${count(health.contextEdits)} context edits`}>
        <p className="text-[12px] text-muted">
          {health.compactions > 0 && `Compactions began from ${formatCompact(health.compactedTokens)} tokens in all. `}
          {runs.length > 0
            ? `Subagent runs: ${runs.map(([status, runCount]) => `${count(runCount)} ${status}`).join(", ")}.`
            : "No subagent runs in this range."}
        </p>
      </Section>
    </Card>
  );
}
