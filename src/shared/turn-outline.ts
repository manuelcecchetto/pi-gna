// The turns of a chat that a client has not loaded, one line each. The desktop opens a chat with its last page of turns
// (SessionHost.snapshot); its turn rail and bookmarks still show the earlier ones from this outline, and a jump to one
// pages it in from the host.
import { splitFileMentions, stripStudioBlocks } from "./file-mentions";
import type { TextContent, UserMessage } from "./protocol";

export interface TurnOutline {
  /** The key of the turn's user item, which is its run's key once the turn is loaded. */
  key: string;
  /** When it was sent: the bookmark identity. */
  at: number;
  /** The message on one line. */
  label: string;
}

/** Longest label kept: the rail and the phone's turn list show one truncated line. */
const LABEL_CHARS = 200;

/** A message you sent, on one line: its text without pi-gna's blocks, else what it attached. */
export function turnLabel(content: UserMessage["content"]): string {
  const raw = typeof content === "string" ? content : content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
  const text = stripStudioBlocks(raw).replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, LABEL_CHARS);
  const mentions = splitFileMentions(raw)[1];
  if (mentions.length) return mentions.map((mention) => mention.label).join(", ").slice(0, LABEL_CHARS);
  const images = typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
  return images > 1 ? `${images} images` : images ? "Image" : "(No content)";
}

export function turnOutline(item: { key: string; message: UserMessage }): TurnOutline {
  return { key: item.key, at: item.message.timestamp, label: turnLabel(item.message.content) };
}
