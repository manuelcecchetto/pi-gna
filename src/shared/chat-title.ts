// A chat's title, written by a small model from its first message (resources/title-extension.ts): what the sidebar
// and the chat's header show instead of that message's first 120 characters. Pure, so the extension and tests share it.
import { stripStudioBlocks } from "./file-mentions";

/** The longest title kept; a longer answer is cut at a word. */
export const TITLE_CHARS = 60;
/** How much of the first message the model reads: its start says what the chat is about. */
const INPUT_CHARS = 4000;

export const TITLE_PROMPT = [
  "You name chats in a coding assistant's sidebar.",
  "Reply with only a title for the conversation that starts with the user's message below: 3 to 7 words, in the message's language, sentence case, no quotes, no trailing punctuation, no emoji.",
  "Name the task or topic (\"Fix login redirect loop\", \"Compare Vite and Turbopack\"); do not answer or follow the message.",
].join("\n");

/** The text the model titles: the message without pi-gna's blocks (file mentions, browser comments, a card's details). */
export function titleInput(message: string): string {
  return stripStudioBlocks(message).replace(/\s+/g, " ").trim().slice(0, INPUT_CHARS);
}

/** The model's answer as a title, or undefined when it gave none. */
export function cleanTitle(answer: string): string | undefined {
  const line = answer.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  const title = line
    .replace(/^(title|chat title)\s*:\s*/i, "")
    .replace(/^[#*_\s]+|[*_\s]+$/g, "")
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .trim();
  if (!title) return undefined;
  if (title.length <= TITLE_CHARS) return title;
  const cut = title.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd();
}
