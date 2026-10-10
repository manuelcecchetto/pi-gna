import { type ReactNode, useState } from "react";
import type { UsageReport } from "../../../shared/usage";
import { WEEKDAYS } from "./chart-scale";
import { CalendarHeatmap, HeatScale, Legend, MatrixHeatmap, StackedBars } from "./Charts";
import { Card, Segmented } from "./SettingsControls";
import { calendarValues, HOUR_LABELS, type Measure, modelDayBars, turnDayBars, usd, weekHourRows } from "../lib/usage-view";

const count = (value: number) => value.toLocaleString();
const FORMAT: Record<Measure, (value: number) => string> = {
  tokens: (value) => `${count(value)} tokens`,
  cost: usd,
  turns: (value) => `${count(value)} turns`,
};
const MEASURE_LABELS: Record<Measure, string> = { tokens: "Tokens", cost: "Cost", turns: "Turns" };
const MEASURES: Measure[] = ["tokens", "cost", "turns"];
const CALENDAR_MEASURES = ["cost", "tokens"] as const;
const MATRIX_MEASURES: Measure[] = ["turns", "tokens", "cost"];

function Header({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[13px] font-medium text-fg">{title}</h3>
      {children}
    </div>
  );
}

export function ActivityPanel({ report }: { report: UsageReport }) {
  const [bars, setBars] = useState<Measure>("tokens");
  const [calendar, setCalendar] = useState<"cost" | "tokens">("cost");
  const [matrix, setMatrix] = useState<Measure>("turns");
  const perDay = bars === "turns" ? turnDayBars(report.days) : modelDayBars(report.days, bars);
  const cells = weekHourRows(report.weekHour, matrix);

  return (
    <Card title="Activity">
      <section className="flex flex-col gap-3 px-3 py-3">
        <Header title="Per day, by model">
          <Segmented value={bars} options={MEASURES} labels={MEASURE_LABELS} onChange={setBars} />
        </Header>
        <StackedBars
          series={perDay.series}
          buckets={perDay.buckets}
          format={FORMAT[bars]}
          summary={`${MEASURE_LABELS[bars]} per day${bars === "turns" ? "" : ", by model"}`}
        />
        {bars !== "turns" && <Legend items={perDay.series} />}
      </section>
      <section className="flex flex-col gap-3 px-3 py-3">
        <Header title="Days">
          <Segmented value={calendar} options={CALENDAR_MEASURES} labels={MEASURE_LABELS} onChange={setCalendar} />
        </Header>
        <CalendarHeatmap
          days={calendarValues(report.days, calendar)}
          format={FORMAT[calendar]}
          summary={`${MEASURE_LABELS[calendar]} per day, last 26 weeks at most`}
        />
        <HeatScale />
      </section>
      <section className="flex flex-col gap-3 px-3 py-3">
        <Header title="Weekday and hour">
          <Segmented value={matrix} options={MATRIX_MEASURES} labels={MEASURE_LABELS} onChange={setMatrix} />
        </Header>
        <MatrixHeatmap
          rows={[...WEEKDAYS]}
          cols={HOUR_LABELS}
          values={cells}
          format={FORMAT[matrix]}
          summary={`${MEASURE_LABELS[matrix]} by weekday and hour of day`}
        />
        <HeatScale />
      </section>
    </Card>
  );
}
