// Output speed next to the context meter: tokens per second of the response streaming now, else of the last one.
import { formatDuration, formatTokens } from "../lib/format";
import type { SessionState } from "../lib/session";
import { latestRate } from "../lib/token-rate";
import { useNow } from "./primitives";

export function TokenRate({ session }: { session: SessionState }) {
  // Ticks while pi runs, so the rate of a stalled stream drops instead of freezing.
  useNow(500, session.running);
  const rate = latestRate(session.items, Date.now());
  if (!rate) return null;
  const about = rate.estimated ? "~" : "";
  const detail = `${about}${formatTokens(Math.round(rate.tokens))} tokens in ${formatDuration(rate.seconds * 1000)}`;
  const title = [
    `${rate.live ? "Output speed of the response streaming now" : "Output speed of the last response"}: ${detail}`,
    rate.estimated ? "Estimated from the streamed text until the provider reports the token count." : "",
  ].filter(Boolean).join("\n");
  return (
    <span title={title} className={`font-mono text-[11.5px] tabular-nums ${rate.live ? "text-muted" : "text-faint"}`}>
      {about}
      {formatRate(rate.perSecond)} tok/s
    </span>
  );
}

function formatRate(perSecond: number): string {
  return perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond));
}
