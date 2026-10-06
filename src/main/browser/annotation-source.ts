// Where a commented element is in a previewed file, so a comment on a file preview names the file and line rather than
// the tab's token URL (docs/FILE_PREVIEW.md, Comments). Pure except for reading the HTML file.
import { readFile, stat } from "node:fs/promises";
import type { Annotation } from "../../shared/browser";
import type { TabPreview } from "../../shared/preview";

/** The picked element as the page sees it: its tag, its index among the page's tags of that name, their count, its id. */
export interface SourceHint {
  tag: string;
  index: number;
  count: number;
  id?: string;
}

const HTML_LIMIT = 2 * 1024 * 1024;
const blank = (text: string) => text.replace(/[^\n]/g, " ");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 1-based line of the element's opening tag in an HTML file, or undefined when it cannot be told for sure: an id found
 * once, else the n-th tag of its name, but only when the file has exactly as many as the page (a script that added or
 * removed some, or a tag the parser implied such as `<tbody>`, makes the count differ).
 */
export function htmlSourceLine(html: string, hint: SourceHint): number | undefined {
  if (!/^[a-z][\w:-]*$/i.test(hint.tag) || !Number.isInteger(hint.index) || hint.index < 0) return undefined;
  // Comments and raw-text bodies can hold tag-like text: blank them, keeping offsets and newlines.
  const text = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<(script|style|textarea|title)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (_all, open: string, _tag: string, body: string, close: string) => open + blank(body) + close);
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  if (hint.id) {
    const id = escapeRegExp(hint.id);
    const found = [...text.matchAll(new RegExp(`<${hint.tag}\\b[^>]*?\\sid\\s*=\\s*(?:"${id}"|'${id}'|${id}(?=[\\s/>]))`, "gi"))];
    if (found.length === 1) return lineAt(found[0]!.index);
  }
  const tags = [...text.matchAll(new RegExp(`<${hint.tag}(?=[\\s/>])`, "gi"))];
  const tag = tags.length === hint.count ? tags[hint.index] : undefined;
  return tag ? lineAt(tag.index) : undefined;
}

/**
 * What a comment on a preview carries instead of the token URL: the file's path, and the line where it is known (the
 * Markdown viewer's block line, a rendered HTML file's tag). Rendered Markdown drops the computed styles: they are the
 * viewer's, nothing the file sets. Web pages: nothing.
 */
export async function previewContext(preview: TabPreview | undefined, line: number | undefined, source: SourceHint | undefined): Promise<Partial<Pick<Annotation, "url" | "file" | "line" | "styles">>> {
  if (!preview) return {};
  const where = { url: preview.path, file: preview.path };
  if (preview.mode !== "rendered") return where;
  if (preview.kind === "markdown") return { ...where, styles: undefined, ...(Number.isInteger(line) && line! > 0 ? { line } : {}) };
  if (preview.kind !== "html" || !source) return where;
  try {
    if ((await stat(preview.path)).size > HTML_LIMIT) return where;
    const found = htmlSourceLine(await readFile(preview.path, "utf8"), source);
    return found ? { ...where, line: found } : where;
  } catch {
    return where;
  }
}
