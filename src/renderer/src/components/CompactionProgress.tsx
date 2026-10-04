import type { CompactionItem } from "../../../shared/session-state";
import { PiSpinner } from "./PiLogo";
import { Elapsed } from "./primitives";

/** One inline lifecycle indicator; do not duplicate it in the composer or work header. */
export function CompactionProgress({ item }: { item: Extract<CompactionItem, { status: "running" }> }) {
  const retry = item.retry;
  const label = retry
    ? `Compacting context · ${retry.waiting ? "waiting to retry" : "retrying"} (${retry.attempt}/${retry.maxAttempts})`
    : "Compacting context…";
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-warn/25 bg-warn/5 px-3.5 py-2.5 text-[13px] text-warn" data-compaction="running">
      <span aria-hidden="true"><PiSpinner size={14} /></span>
      <span role="status" aria-live="polite" aria-atomic="true">
        {label}
      </span>
      <span className="ml-auto shrink-0 text-[12px] text-faint" aria-hidden="true">
        <Elapsed since={item.startedAt} plain />
      </span>
    </div>
  );
}
