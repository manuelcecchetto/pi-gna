// The composer's tok/s readout: how fast the model produced a response, its output tokens over the time from
// `message_start` to `message_end`. Providers report output tokens only when a response ends (Anthropic's
// message_delta, OpenAI's response.completed), so pi's message_update usage is not live: while streaming, the count
// is estimated from everything streamed so far (text, thinking and tool-call arguments).
//
// Tokens are counted in one unit for every model, four characters, because tokenizers differ: an OpenAI token carries
// about 1.7 times the characters of a Claude token, so raw tok/s made OpenAI models look slow. A finished response's
// reported count is converted with its model's characters per token, learned from the chat's own responses (answer
// characters over answer tokens, reasoning left out because it is hidden or summarized), so hidden reasoning still
// counts by its token count.
import type { AssistantMessage } from "./protocol";
import type { AssistantItem, Item } from "./session-state";

/** The unit: four characters a token, as pi estimates. */
const CHARS_PER_TOKEN = 4;
/** Answer tokens of prior at CHARS_PER_TOKEN a model's ratio starts from, so a chat's first responses do not swing it. */
const PRIOR_TOKENS = 500;
/** Shorter responses give noisy rates (one that arrives in a single chunk would read as thousands of tok/s). */
const MIN_SECONDS = 0.5;

export interface ResponseRate {
  /** Four-character tokens per second. */
  perSecond: number;
  /** In four-character tokens. */
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
export function responseRate(item: AssistantItem, now: number, ratios: Map<string, number> = tokenizerRatios([item])): ResponseRate | undefined {
  const span = item.span;
  if (!span) return undefined;
  const end = item.streaming ? now : span.end;
  if (end === undefined) return undefined; // cut off: no end time
  const seconds = (end - span.start) / 1000;
  if (seconds < MIN_SECONDS) return undefined;
  const output = item.streaming ? 0 : (item.message.usage?.output ?? 0);
  if (output <= 0) {
    const tokens = Math.round(streamedChars(item) / CHARS_PER_TOKEN);
    if (tokens <= 0) return undefined;
    return { perSecond: tokens / seconds, tokens, seconds, estimated: true, live: item.streaming };
  }
  const charsPerToken = ratios.get(modelKey(item.message)) ?? CHARS_PER_TOKEN;
  const tokens = (output * charsPerToken) / CHARS_PER_TOKEN;
  return { perSecond: tokens / seconds, tokens, seconds, estimated: false, live: item.streaming };
}

/**
 * Each model's characters per token in this chat, by `provider/model`: the answer characters (text and tool-call
 * arguments) of its finished responses over their answer tokens (output less reasoning), starting from
 * CHARS_PER_TOKEN. A response whose thinking shows but whose reasoning tokens are not reported is left out: its
 * answer tokens are unknown.
 */
export function tokenizerRatios(items: Item[]): Map<string, number> {
  const sums = new Map<string, { chars: number; tokens: number }>();
  for (const item of items) {
    if (item.kind !== "assistant" || item.streaming) continue;
    const sample = answerSample(item.message);
    if (!sample) continue;
    const key = modelKey(item.message);
    const sum = sums.get(key) ?? { chars: 0, tokens: 0 };
    sum.chars += sample.chars;
    sum.tokens += sample.tokens;
    sums.set(key, sum);
  }
  const ratios = new Map<string, number>();
  for (const [key, sum] of sums) ratios.set(key, (sum.chars + PRIOR_TOKENS * CHARS_PER_TOKEN) / (sum.tokens + PRIOR_TOKENS));
  return ratios;
}

const modelKey = (message: AssistantMessage) => `${message.provider}/${message.model}`;

/** Finished messages do not change: their sample is counted once (tool arguments can be large). */
const samples = new WeakMap<AssistantMessage, { chars: number; tokens: number } | null>();

function answerSample(message: AssistantMessage): { chars: number; tokens: number } | undefined {
  let sample = samples.get(message);
  if (sample === undefined) {
    const reasoning = message.usage?.reasoning ?? 0;
    const tokens = (message.usage?.output ?? 0) - reasoning;
    let chars = 0;
    let thinking = false;
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "toolCall") chars += JSON.stringify(block.arguments).length;
      else if (block.type === "thinking") thinking = true;
    }
    sample = tokens > 0 && chars > 0 && (reasoning > 0 || !thinking) ? { chars, tokens } : null;
    samples.set(message, sample);
  }
  return sample ?? undefined;
}

/** The newest response with a rate: the one streaming, else the last one measured (also after the run). */
export function latestRate(items: Item[], now: number): ResponseRate | undefined {
  const ratios = tokenizerRatios(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    const rate = responseRate(item, now, ratios);
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
  const ratios = tokenizerRatios(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant" || !item.span) continue;
    const rate = responseRate(item, now, ratios);
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
