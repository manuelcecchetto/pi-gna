// What the phone's File screen (FileView.tsx) decides without a DOM: which files it draws itself, and where a line
// lands in rendered Markdown.
import type { BrowserTab } from "../shared/browser";
import { kindFor, type PreviewKind } from "../shared/preview";

/**
 * Kinds the phone draws itself; the rest (PDF, Office, HTML, media) stream the Mac's preview tab on the Browser screen.
 * "other" is read too: the host tells text from binary, and a binary file offers the stream.
 */
const DRAWN: ReadonlySet<PreviewKind> = new Set(["markdown", "code", "text", "json", "table", "image", "other"]);

export const drawnOnPhone = (path: string): boolean => DRAWN.has(kindFor(path));

/** What the Browser screen draws for a preview tab of a file the phone draws itself; undefined streams the tab. */
export interface DrawnPreview {
  /** The chat whose folders the file is read from (`chat.readFile` refuses others). */
  chat: string;
  path: string;
  rev?: number;
  /** The line the tab was opened at (`#L12` on its URL). */
  line?: number;
}

/** `chat` is the chat the Browser screen opened from; without one the tab's owner reads it. */
export function drawnPreview(tab: BrowserTab, chat?: string): DrawnPreview | undefined {
  const owner = chat ?? tab.agent;
  if (!tab.preview || !owner || !drawnOnPhone(tab.preview.path)) return undefined;
  const line = Number(/#L(\d+)$/.exec(tab.url)?.[1]);
  return { chat: owner, path: tab.preview.path, rev: tab.preview.rev, line: line > 0 ? line : undefined };
}

/** The rendered block a 1-based source line falls in: the last one starting at or before it (blocks in order). */
export function blockForLine(starts: number[], line: number): number {
  let index = 0;
  starts.forEach((start, i) => {
    if (start <= line) index = i;
  });
  return index;
}

/** Lines the front matter takes before `body`, the rest of `text`. */
export const linesBefore = (text: string, body: string): number => text.slice(0, text.length - body.length).split("\n").length - 1;

/** Pretty-printed JSON for rendered mode; the text itself when it does not parse (JSONC, truncated). */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
