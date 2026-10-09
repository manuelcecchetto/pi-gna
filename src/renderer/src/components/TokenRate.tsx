// Output speed next to the context meter: tokens per second of the response streaming now, else of the last one.
import { memo } from "react";
import { formatDuration, formatTokens } from "../lib/format";
import type { Item } from "../../../shared/session-state";
import { latestRate, rateMoving } from "../../../shared/token-rate";
import { useNow } from "./primitives";

export const TokenRate = memo(function TokenRate({ items, running }: { items: Item[]; running: boolean }) {
  // Ticks while the rate moves on its own: it follows the stream, and holds once a pause outlasts STALL_MS.
  useNow(500, running && rateMoving(items, Date.now()));
  const rate = latestRate(items, Date.now());
  if (!rate) return null;
  const about = rate.estimated ? "~" : "";
  const detail = `${about}${formatTokens(Math.round(rate.tokens))} tokens in ${formatDuration(rate.seconds * 1000)}`;
  const title = [
    `${rate.live ? "Output speed of the response streaming now" : "Output speed of the last response"}: ${detail}`,
    rate.estimated ? "Estimated from the streamed text until the provider reports the token count." : "",
  ].filter(Boolean).join("\n");
  return (
    <span title={title} className={`whitespace-nowrap font-mono text-[11.5px] tabular-nums ${rate.live ? "text-muted" : "text-faint"}`}>
      {about}
      {formatRate(rate.perSecond)} tok/s
    </span>
  );
});

function formatRate(perSecond: number): string {
  return perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond));
}
