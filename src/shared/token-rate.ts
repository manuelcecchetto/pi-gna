// The composer's tok/s readout: how fast the model streams a response. Providers report output tokens only
// when a response ends (Anthropic's message_delta, OpenAI's response.completed), so pi's message_update usage
// is not live: while streaming, the count is estimated from the streamed characters. Only text and thinking count:
// tool-call arguments often arrive in one burst after the provider buffered them, which reads as hundreds of tok/s.
import type { AssistantItem, Item } from "./session-state";

/** About four characters per token, as pi estimates. */
const CHARS_PER_TOKEN = 4;
/** Shorter streams give noisy rates. */
const MIN_SECONDS = 0.5;
/**
 * A longer pause between text and thinking events is a wait, not streaming: a tool call in between, reasoning the
 * provider does not stream, a stalled connection. At most this much of each pause counts.
 */
export const STALL_MS = 1000;

/** Time a response spent streaming: `ms` up to the stream event at `at`. */
export interface StreamClock {
  ms: number;
  at: number;
}

/**
 * The clock after a text or thinking stream event at `now` (tool-call events do not tick it); the first event starts
 * it, so time to first token does not count.
 */
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
 * Output tokens per second of one response while it streams text and thinking: tool-call arguments, time to first
 * token, waits between stream events (see `STALL_MS`) and tool runs do not count. Undefined without timings (responses read from a session
 * file) or while too short to tell.
 */
export function responseRate(item: AssistantItem, now: number): ResponseRate | undefined {
  const clock = item.clock;
  if (!clock) return undefined;
  const times = Object.values(item.times ?? {});
  if (!item.streaming && times.some((time) => time.end === undefined)) return undefined; // cut off: no end time
  // While a tool call streams, the clock holds: its arguments do not count, so neither does its time.
  const live = item.streaming && item.message.content.at(-1)?.type !== "toolCall";
  const seconds = (live ? tickStream(clock, now).ms : clock.ms) / 1000;
  if (seconds < MIN_SECONDS) return undefined;
  const { tokens, estimated } = countTokens(item);
  if (tokens <= 0) return undefined;
  return { perSecond: tokens / seconds, tokens, seconds, estimated, live: item.streaming };
}

/**
 * The newest response with a rate: the one streaming, else the last one measured (also after the run). Stops at the
 * newest response read from the session file (no `times`): it and every older one have no timings, so a chat opened
 * from disk is not walked on every frame.
 */
export function latestRate(items: Item[], now: number): ResponseRate | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    if (!item.times) return undefined;
    const rate = responseRate(item, now);
    if (rate) return rate;
  }
  return undefined;
}

/**
 * Whether `latestRate` still changes with time alone: the newest response streams text or thinking and its last stream
 * event is under `STALL_MS` old. Past that the rate holds until the next event changes the items.
 */
export function rateMoving(items: Item[], now: number): boolean {
  const item = items.findLast((candidate): candidate is AssistantItem => candidate.kind === "assistant");
  if (!item?.streaming || !item.clock || item.message.content.at(-1)?.type === "toolCall") return false;
  return now - item.clock.at < STALL_MS;
}

function countTokens(item: AssistantItem): { tokens: number; estimated: boolean } {
  const chars = streamedChars(item);
  const usage = item.streaming ? undefined : item.message.usage;
  const output = usage?.output ?? 0;
  // The provider's count includes tool-call arguments, which cannot be split off reliably: estimate instead.
  if (output <= 0 || chars.toolCalls) return { tokens: Math.round((chars.thinking + chars.text) / CHARS_PER_TOKEN), estimated: true };
  if (!usage?.reasoning) return { tokens: output, estimated: false };
  // Reasoning tokens include reasoning that was never streamed (OpenAI's hidden reasoning, Claude's summarized
  // thinking), produced while nothing streamed: count only the reasoning text that did stream.
  const visible = Math.max(0, output - usage.reasoning);
  return { tokens: visible + Math.round(chars.thinking / CHARS_PER_TOKEN), estimated: chars.thinking > 0 };
}

function streamedChars(item: AssistantItem): { thinking: number; text: number; toolCalls: boolean } {
  const chars = { thinking: 0, text: 0, toolCalls: false };
  for (const block of item.message.content) {
    if (block.type === "text") chars.text += block.text.length;
    else if (block.type === "thinking" && !block.redacted) chars.thinking += block.thinking.length;
    else if (block.type === "toolCall") chars.toolCalls = true;
  }
  return chars;
}
