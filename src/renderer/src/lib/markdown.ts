// Markdown -> sanitized HTML. Model output is untrusted: DOMPurify always runs, remote images are
// blocked by CSP, and web links open outside the app, local file links
// become `data-file` chips the component wires to the file preview, and local images (`![alt](path)`, or a raw
// `<img src="path">`) become `data-image` placeholders it loads through main (docs/FILE_PREVIEW.md, Chat links).
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { cardLinkId } from "../../../shared/board";
import { isLocalLinkHref, kindFor, looksLikePath, parseLinkTarget } from "../../../shared/preview";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

export interface MarkdownOptions {
  /** Turn complete ```visual fences into placeholders for the sandboxed frame. */
  visuals?: boolean;
  /**
   * Local link targets become file chips for the chat to resolve (default). Off for the file viewer, whose links stay
   * plain hrefs that it resolves against the previewed file and follows in its own tab.
   */
  fileLinks?: boolean;
  /** Turn local images (`![alt](path)`) into placeholders the chat loads; the file viewer resolves its own. */
  localImages?: boolean;
}

/** Fragment cap, shared with the frame host (docs/DESIGN.md, Visuals). */
export const VISUAL_MAX_BYTES = 64 * 1024;

// marked renderers have no per-call options, so markdownToHtml sets this around each synchronous parse.
let visualsOn = false;
let fileLinksOn = true;
let localImagesOn = false;

/**
 * The chip a local image target renders as: a placeholder showing `alt` that the component swaps for the image, or a
 * file link when the target is not an image. `size` carries a raw `<img>`'s width and height to the loaded image.
 */
function localImageChip(href: string, alt: string, size: { width?: string; height?: string } = {}): string {
  const target = escapeHtml(href.trim());
  const kind = kindFor(parseLinkTarget(href, "/")?.path ?? href);
  const label = escapeHtml(alt || href.trim().split("/").pop() || href);
  if (kind !== "image") return `<span class="file-link" role="link" tabindex="0" data-file="${target}" data-kind="${kind}">${label}</span>`;
  const dims = (["width", "height"] as const).map((name) => (size[name] ? ` data-${name}="${size[name]}"` : "")).join("");
  return `<span class="file-link chat-image" role="link" tabindex="0" data-image="${target}" data-file="${target}" data-kind="image"${dims}>${label}</span>`;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" };
const IMG_TAG = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Raw `<img>` tags with a local `src` become image chips, like `![alt](src)`; the rest of the HTML is left to DOMPurify. */
function localImageTags(html: string): string {
  return html.replace(IMG_TAG, (tag, body: string) => {
    const attributes: Record<string, string> = {};
    for (const [, name, double, single, bare] of body.matchAll(ATTRIBUTE)) {
      attributes[name!.toLowerCase()] = (double ?? single ?? bare ?? "").replace(/&(amp|quot|apos|lt|gt|#39);/g, (_, entity: string) => ENTITIES[entity]!);
    }
    const src = attributes.src ?? "";
    if (!isLocalLinkHref(src)) return tag;
    const dimension = (value?: string) => (value && /^\d{1,4}%?$/.test(value) ? value : undefined);
    return localImageChip(src, attributes.alt ?? "", { width: dimension(attributes.width), height: dimension(attributes.height) });
  });
}

/** True when the fence's raw text ends with a closing fence line (false while streaming). */
function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\n+$/, "").split("\n");
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
  const marker = open?.[1];
  if (!marker || lines.length < 2) return false;
  const closer = (lines[lines.length - 1] ?? "").trim();
  return closer.length >= marker.length && closer === marker.charAt(0).repeat(closer.length);
}

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang, raw }) {
      const label = escapeHtml((lang ?? "").split(/\s/)[0] || "text");
      let note = "";
      if (visualsOn && label === "visual") {
        if (!isClosedFence(raw)) {
          // Streaming: still a plain code block until the closing fence arrives.
        } else if (new TextEncoder().encode(text).length > VISUAL_MAX_BYTES) {
          note = `<p class="visual-note">Visual too large to render (over ${VISUAL_MAX_BYTES / 1024} KB); showing source.</p>`;
        } else {
          // The source stays as escaped text in a hidden element; the component reads textContent and
          // sends it to the sandboxed frame. It is never parsed as HTML in the app document.
          return `<div class="visual" data-visual><pre class="visual-src" hidden>${escapeHtml(text)}</pre></div>`;
        }
      }
      return note + `<div class="code-block"><header><span>${label}</span><button type="button" data-copy>Copy</button></header><pre><code data-lang="${label}">${escapeHtml(text)}</code></pre></div>`;
    },
    // Local file targets get no href (nothing can navigate); the component resolves and opens them.
    link({ href, tokens }) {
      // A card id is not a file: the component opens that card on the board.
      const card = fileLinksOn ? cardLinkId(href) : undefined;
      if (card) return `<span class="card-link" role="link" tabindex="0" data-card="${card}">${this.parser.parseInline(tokens)}</span>`;
      if (!fileLinksOn || !isLocalLinkHref(href)) return false;
      const kind = kindFor(parseLinkTarget(href, "/")?.path ?? href);
      return `<span class="file-link" role="link" tabindex="0" data-file="${escapeHtml(href.trim())}" data-kind="${kind}">${this.parser.parseInline(tokens)}</span>`;
    },
    // A local image is a placeholder showing its alt text; the component swaps in the image once it loads.
    // Other local targets read as a file link, web images stay `<img>` for CSP to block.
    image({ href, text }) {
      if (!localImagesOn || !isLocalLinkHref(href)) return false;
      return localImageChip(href, text);
    },
    // Raw HTML (a `<table>` of screenshots, say) keeps its tags for DOMPurify; its local `<img>`s load like `![]()`.
    html({ text }) {
      return localImagesOn ? localImageTags(text) : false;
    },
    // Inline code that reads as a path is a candidate; the component links it only if the file exists.
    codespan({ text }) {
      return looksLikePath(text) ? `<code data-path="${escapeHtml(text.trim())}">${escapeHtml(text)}</code>` : false;
    },
    // Task lists: a styled box instead of an <input>, which the sanitizer strips.
    checkbox({ checked }) {
      return `<span class="task-box${checked ? " done" : ""}" aria-hidden="true"></span>`;
    },
  },
});

/**
 * 1-based line each top-level block of `source` starts on, in the order marked renders them (one element each, except
 * raw HTML blocks); undefined when a block's text cannot be found. The file viewer puts them on the rendered blocks
 * so a comment on one can name its line.
 */
export function markdownBlockLines(source: string): number[] | undefined {
  const text = source.replace(/\r\n?/g, "\n");
  const lines: number[] = [];
  let at = 0;
  let line = 1;
  for (const token of marked.lexer(text)) {
    if (token.type === "space" || token.type === "def") continue;
    const found = text.indexOf(token.raw, at);
    if (found < 0) return undefined;
    for (let i = at; i < found; i++) if (text.charCodeAt(i) === 10) line++;
    lines.push(line);
    for (let i = found; i < found + token.raw.length; i++) if (text.charCodeAt(i) === 10) line++;
    at = found + token.raw.length;
  }
  return lines;
}

/** Markdown -> HTML before sanitizing (exported for tests). */
export function markdownToHtml(source: string, options: MarkdownOptions = {}): string {
  visualsOn = options.visuals === true;
  fileLinksOn = options.fileLinks !== false;
  localImagesOn = options.localImages === true;
  try {
    return marked.parse(source, { async: false }) as string;
  } finally {
    visualsOn = false;
    fileLinksOn = true;
    localImagesOn = false;
  }
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return DOMPurify.sanitize(markdownToHtml(source, options), { ADD_ATTR: ["data-lang", "data-copy", "data-visual", "data-file", "data-card", "data-kind", "data-path", "data-image", "data-width", "data-height"], FORBID_TAGS: ["style", "form", "input"] });
}
