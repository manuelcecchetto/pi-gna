// The composer's tok/s readout: how fast the model produced a response, its output tokens over the time from
// `message_start` to `message_end`. Providers report output tokens only when a response ends (Anthropic's
// message_delta, OpenAI's response.completed), so pi's message_update usage is not live: while streaming, the count
// is estimated from everything streamed so far (text, thinking and tool-call arguments).
import type { AssistantItem, Item } from "./session-state";

/** About four characters per token, as pi estimates. */
const CHARS_PER_TOKEN = 4;
/** Shorter responses give noisy rates (one that arrives in a single chunk would read as thousands of tok/s). */
const MIN_SECONDS = 0.5;

export interface ResponseRate {
  perSecond: number;
  tokens: number;
  seconds: number;
  /** Counted from the streamed characters until the provider reports the count. */
  estimated: boolean;
  /** The response is still streaming. */
  live: boolean;
}

/**
 * Output tokens per second of one response over its whole request, time to first token included; tool runs fall
 * between responses. Undefined without timings, when cut off before it ended, or while too short to tell.
 */
export function responseRate(item: AssistantItem, now: number): ResponseRate | undefined {
  const span = item.span;
  if (!span) return undefined;
  const end = item.streaming ? now : span.end;
  if (end === undefined) return undefined; // cut off: no end time
  const seconds = (end - span.start) / 1000;
  if (seconds < MIN_SECONDS) return undefined;
  const output = item.streaming ? 0 : (item.message.usage?.output ?? 0);
  const estimated = output <= 0;
  const tokens = estimated ? Math.round(streamedChars(item) / CHARS_PER_TOKEN) : output;
  if (tokens <= 0) return undefined;
  return { perSecond: tokens / seconds, tokens, seconds, estimated, live: item.streaming };
}

/** The newest response with a rate: the one streaming, else the last one measured (also after the run). */
export function latestRate(items: Item[], now: number): ResponseRate | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    const rate = responseRate(item, now);
    if (rate) return rate;
  }
  return undefined;
}

/** One measured response for the speed chart: when it ended (now while it streams) and its rate. */
export interface RatePoint extends ResponseRate {
  at: number;
}

/** Every measured response of the chat, oldest first, for the hover chart; those read from the session file too. */
export function rateHistory(items: Item[], now: number): RatePoint[] {
  const points: RatePoint[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant" || !item.span) continue;
    const rate = responseRate(item, now);
    if (rate) points.push({ ...rate, at: item.streaming ? now : (item.span.end ?? now) });
  }
  return points.reverse();
}

/** Whether `latestRate` still changes with time alone: the newest response is streaming. */
export function rateMoving(items: Item[]): boolean {
  const item = items.findLast((candidate): candidate is AssistantItem => candidate.kind === "assistant");
  return Boolean(item?.streaming && item.span);
}

function streamedChars(item: AssistantItem): number {
  let chars = 0;
  item.message.content.forEach((block, i) => {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking" && !block.redacted) chars += block.thinking.length;
    else if (block.type === "toolCall") chars += item.partialArgs?.[i]?.json.text.length ?? JSON.stringify(block.arguments).length;
  });
  return chars;
}
