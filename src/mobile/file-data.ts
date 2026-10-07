// What the phone's File screen (FileView.tsx) decides without a DOM: which files it draws itself, and where a line
// lands in rendered Markdown.
import { kindFor, type PreviewKind } from "../shared/preview";

/**
 * Kinds the phone draws itself; the rest (PDF, Office, HTML, media) stream the Mac's preview tab on the Browser screen.
 * "other" is read too: the host tells text from binary, and a binary file offers the stream.
 */
const DRAWN: ReadonlySet<PreviewKind> = new Set(["markdown", "code", "text", "json", "table", "image", "other"]);

export const drawnOnPhone = (path: string): boolean => DRAWN.has(kindFor(path));

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
