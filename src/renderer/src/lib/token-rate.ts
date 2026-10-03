// The composer's tok/s readout: how fast the model streams a response. Providers report output tokens only
// when a response ends (Anthropic's message_delta, OpenAI's response.completed), so pi's message_update usage
// is not live: while streaming, the count is estimated from the streamed characters.
import type { AssistantItem, Item } from "./session";

/** About four characters per token, as pi estimates. */
const CHARS_PER_TOKEN = 4;
/** Shorter streams give noisy rates, for example a tool call that arrives in one burst. */
const MIN_SECONDS = 0.5;

export interface ResponseRate {
  perSecond: number;
  tokens: number;
  seconds: number;
  /** Counted from the streamed characters; the provider's count replaces it when the response ends. */
  estimated: boolean;
  /** The response is still streaming. */
  live: boolean;
}

/**
 * Output tokens per second of one response, from its first streamed block to its last (or now, while it
 * streams): time to first token and tool runs do not count. Undefined without timings (responses read from
 * a session file) or while too short to tell.
 */
export function responseRate(item: AssistantItem, now: number): ResponseRate | undefined {
  const times = Object.values(item.times ?? {});
  if (!times.length) return undefined;
  if (!item.streaming && times.some((time) => time.end === undefined)) return undefined; // cut off: no end time
  const start = Math.min(...times.map((time) => time.start));
  const end = item.streaming ? now : Math.max(...times.map((time) => time.end ?? time.start));
  const seconds = (end - start) / 1000;
  if (seconds < MIN_SECONDS) return undefined;
  const reported = item.streaming ? 0 : (item.message.usage?.output ?? 0);
  const tokens = reported > 0 ? reported : estimateTokens(item);
  if (tokens <= 0) return undefined;
  return { perSecond: tokens / seconds, tokens, seconds, estimated: reported <= 0, live: item.streaming };
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

function estimateTokens(item: AssistantItem): number {
  let chars = 0;
  item.message.content.forEach((block, index) => {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking" && !block.redacted) chars += block.thinking.length;
    else if (block.type === "toolCall") chars += item.partialArgs?.[index]?.length ?? JSON.stringify(block.arguments).length;
  });
  return Math.round(chars / CHARS_PER_TOKEN);
}
