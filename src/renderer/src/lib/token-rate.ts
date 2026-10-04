// The composer's tok/s readout: how fast the model streams a response. Providers report output tokens only
// when a response ends (Anthropic's message_delta, OpenAI's response.completed), so pi's message_update usage
// is not live: while streaming, the count is estimated from the streamed characters.
import type { AssistantItem, Item } from "./session";

/** About four characters per token, as pi estimates. */
const CHARS_PER_TOKEN = 4;
/** Shorter streams give noisy rates, for example a tool call that arrives in one burst. */
const MIN_SECONDS = 0.5;
/**
 * A longer pause between stream events is a wait, not streaming: tool input the provider buffers, reasoning it
 * does not stream, a stalled connection. At most this much of each pause counts.
 */
export const STALL_MS = 1000;

/** Time a response spent streaming: `ms` up to the stream event at `at`. */
export interface StreamClock {
  ms: number;
  at: number;
}

/** The clock after a stream event at `now`; the first event starts it, so time to first token does not count. */
export function tickStream(clock: StreamClock | undefined, now: number): StreamClock {
  return clock ? { ms: clock.ms + Math.min(now - clock.at, STALL_MS), at: now } : { ms: 0, at: now };
}

export interface ResponseRate {
  perSecond: number;
  tokens: number;
  seconds: number;
  /** Counted from the streamed characters, wholly or for reasoning; the provider's count replaces it where it can. */
  estimated: boolean;
  /** The response is still streaming. */
  live: boolean;
}

/**
 * Output tokens per second of one response while it streams tokens: time to first token, waits between stream
 * events (see `STALL_MS`) and tool runs do not count. Undefined without timings (responses read from a session
 * file) or while too short to tell.
 */
export function responseRate(item: AssistantItem, now: number): ResponseRate | undefined {
  const clock = item.clock;
  if (!clock) return undefined;
  const times = Object.values(item.times ?? {});
  if (!item.streaming && times.some((time) => time.end === undefined)) return undefined; // cut off: no end time
  const seconds = (item.streaming ? tickStream(clock, now).ms : clock.ms) / 1000;
  if (seconds < MIN_SECONDS) return undefined;
  const { tokens, estimated } = countTokens(item);
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

function countTokens(item: AssistantItem): { tokens: number; estimated: boolean } {
  const chars = streamedChars(item);
  const usage = item.streaming ? undefined : item.message.usage;
  const output = usage?.output ?? 0;
  if (output <= 0) return { tokens: Math.round((chars.thinking + chars.other) / CHARS_PER_TOKEN), estimated: true };
  if (!usage?.reasoning) return { tokens: output, estimated: false };
  // Reasoning tokens include reasoning that was never streamed (OpenAI's hidden reasoning, Claude's summarized
  // thinking), produced while nothing streamed: count only the reasoning text that did stream.
  const visible = Math.max(0, output - usage.reasoning);
  return { tokens: visible + Math.round(chars.thinking / CHARS_PER_TOKEN), estimated: chars.thinking > 0 };
}

function streamedChars(item: AssistantItem): { thinking: number; other: number } {
  const chars = { thinking: 0, other: 0 };
  item.message.content.forEach((block, index) => {
    if (block.type === "text") chars.other += block.text.length;
    else if (block.type === "thinking" && !block.redacted) chars.thinking += block.thinking.length;
    else if (block.type === "toolCall") chars.other += item.partialArgs?.[index]?.length ?? JSON.stringify(block.arguments).length;
  });
  return chars;
}
