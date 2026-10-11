// Composer autocomplete (Settings > Agent > Beta, off by default): ghost text that suggests how the message being
// typed goes on, from a small typeahead model run by a local llama.cpp server (src/main/autocomplete). Nothing leaves
// the computer. The prompt carries the chat's last exchange and a few of the user's earlier messages in the same
// project, picked by word overlap: in a bake-off on 598 real drafts those earlier messages were the one context that
// clearly helped (docs/DESIGN.md, Composer autocomplete). Everything here is pure, for both sides and the tests.

import type { Item } from "./session-state";

/** Where the local model is: off, being fetched (0..1), loading, answering, or failed. */
export type AutocompletePhase = "off" | "downloading" | "starting" | "ready" | "error";

export interface AutocompleteStatus {
  phase: AutocompletePhase;
  /** 0..1 while downloading. */
  progress?: number;
  /** Why the last install or start failed, in words for the Settings row. */
  error?: string;
}

/** What the composer sends for one suggestion. */
export interface SuggestRequest {
  cwd: string;
  /** The text before the caret. */
  draft: string;
  /** The chat's last user message and the agent's last reply, when there are any. */
  lastUser?: string;
  lastAgent?: string;
}

/** Longest draft, previous message and reply the prompt keeps (their ends), and the earlier messages (their starts). */
export const DRAFT_CHARS = 1200;
export const LAST_USER_CHARS = 300;
export const LAST_AGENT_CHARS = 600;
export const EXAMPLE_CHARS = 250;
export const EXAMPLES = 3;
/** Words a suggestion may have at most: the model is asked for 16 tokens and cut at the line's end. */
export const MAX_WORDS = 12;

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const tail = (text: string, chars: number) => flat(text).slice(-chars).trim();
const head = (text: string, chars: number) => flat(text).slice(0, chars).trim();

/** Lowercase words of 3+ characters, the units earlier messages are matched by. */
export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
}

/**
 * Whether a user message was typed by a person and is worth showing the model: pi-gna's own task prompts, pastes,
 * code and one-word replies are not how someone writes, so they would teach the wrong voice.
 */
export function isTypedPrompt(text: string): boolean {
  const value = text.trim();
  if (value.length > 900 || value.includes("```") || /^(#|<|\[)/.test(value)) return false;
  if (/<(kanban-card|system-reminder|in-app-browser-context)\b/.test(value)) return false;
  if (/^(Continue the existing task|Resolve this card|Triage this new card|Investigate this card|Fix the gap this lament|Implement this)/.test(value)) return false;
  if (value.split(/\s+/).length < 6) return false;
  let letters = 0;
  for (const char of value) if (/[\p{L} ]/u.test(char)) letters++;
  return letters / value.length >= 0.8;
}

/** The `count` earlier messages sharing the most words with the draft (scaled down for long ones), best first. */
export function pickExamples(draft: string, prompts: readonly string[], count = EXAMPLES): string[] {
  const query = words(draft);
  if (!query.size) return [];
  const scored: { text: string; score: number }[] = [];
  for (const text of prompts) {
    const own = words(text);
    let shared = 0;
    for (const word of own) if (query.has(word)) shared++;
    if (shared) scored.push({ text, score: shared / (1 + Math.sqrt(own.size)) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.text);
}

/**
 * The plain-text prompt the typeahead model continues (no chat template): it was trained on a scene line, the
 * `***Roleplay chat below***` marker and name-prefixed turns, ending in the user's half-typed message.
 */
export function buildPrompt(request: Pick<SuggestRequest, "draft" | "lastUser" | "lastAgent">, examples: readonly string[]): string {
  const lines = ["A software developer is chatting with an AI coding agent about their project."];
  if (examples.length) lines.push("Earlier messages from the user:", ...examples.map((example) => `- ${head(example, EXAMPLE_CHARS)}`));
  lines.push("***Roleplay chat below***");
  if (request.lastUser?.trim()) lines.push(`User: ${tail(request.lastUser, LAST_USER_CHARS)}`);
  if (request.lastAgent?.trim()) lines.push(`Agent: ${tail(request.lastAgent, LAST_AGENT_CHARS)}`);
  lines.push(`User: ${tail(request.draft, DRAFT_CHARS)}`);
  return lines.join("\n");
}

/**
 * The ghost text for `draft` from the model's raw continuation, or "" for none. The model was trained to start at a
 * word boundary, so a continuation of the last typed word is dropped rather than guessed at; after a trailing space
 * the suggestion starts with its word, otherwise with the space before it, and punctuation joins the last word.
 */
export function cleanSuggestion(raw: string, draft: string): string {
  const line = raw.split("\n")[0]!.replace(/\s+$/, "");
  if (!line.trim() || /^[\p{L}\p{N}]/u.test(line)) return "";
  const kept = line.trimStart().split(/\s+/).slice(0, MAX_WORDS).join(" ");
  // Punctuation joins the last word; a word goes after a space.
  if (!/^\s/.test(line)) return kept;
  return /\s$/.test(draft) || draft === "" ? kept : ` ${kept}`;
}

/** Whether a draft gets suggestions: some text, caret on a line with words, not a slash command. */
export function wantsSuggestion(draft: string): boolean {
  if (!draft.trim() || draft.trimStart().startsWith("/")) return false;
  const line = draft.slice(draft.lastIndexOf("\n") + 1);
  return line.trim().length >= 2;
}

/**
 * What is left of `ghost` after the text grew from `before` to `after`: typing the ghost's own characters eats it,
 * anything else drops it. Undefined: nothing left, ask again.
 */
export function remainingGhost(before: string, ghost: string, after: string): string | undefined {
  if (!ghost || !after.startsWith(before)) return undefined;
  const typed = after.slice(before.length);
  if (!ghost.startsWith(typed)) return undefined;
  const rest = ghost.slice(typed.length);
  return rest.trim() ? rest : undefined;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
      : "";

/** The chat's last message from the user and the agent's last words, the context a suggestion continues from. */
export function lastExchange(items: readonly Item[]): Pick<SuggestRequest, "lastUser" | "lastAgent"> {
  let lastUser: string | undefined;
  let lastAgent: string | undefined;
  for (let index = items.length - 1; index >= 0 && (lastUser === undefined || lastAgent === undefined); index--) {
    const item = items[index]!;
    if (item.kind === "user" && lastUser === undefined) lastUser = textOf(item.message.content).trim() || undefined;
    else if (item.kind === "assistant" && lastAgent === undefined) lastAgent = textOf(item.message.content).trim() || undefined;
  }
  return { ...(lastUser && { lastUser }), ...(lastAgent && { lastAgent }) };
}
