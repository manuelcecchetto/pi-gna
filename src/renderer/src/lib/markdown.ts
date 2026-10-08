// Markdown -> sanitized HTML. Model output is untrusted: DOMPurify always runs, remote images are
// blocked by CSP, and web links open outside the app, local file links
// become `data-file` chips the component wires to the file preview, and local images (`![alt](path)`, or a raw
// `<img src="path">`) become `data-image` placeholders it loads through main (docs/FILE_PREVIEW.md, Chat links).
import DOMPurify from "dompurify";
import { Marked, type Token, type Tokens } from "marked";
import { cardLinkId } from "../../../shared/board";
import { isLocalLinkHref, kindFor, looksLikePath, parseLinkTarget } from "../../../shared/preview";
import { IMG_TAG, imgAttributes } from "../../../shared/markdown-images";

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

/** Raw `<img>` tags with a local `src` become image chips, like `![alt](src)`; the rest of the HTML is left to DOMPurify. */
function localImageTags(html: string): string {
  return html.replace(IMG_TAG, (tag, body: string) => {
    const attributes = imgAttributes(body);
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

function withOptions(options: MarkdownOptions, render: () => string): string {
  visualsOn = options.visuals === true;
  fileLinksOn = options.fileLinks !== false;
  localImagesOn = options.localImages === true;
  try {
    return render();
  } finally {
    visualsOn = false;
    fileLinksOn = true;
    localImagesOn = false;
  }
}

/** Markdown -> HTML before sanitizing (exported for tests). */
export function markdownToHtml(source: string, options: MarkdownOptions = {}): string {
  return withOptions(options, () => marked.parse(source, { async: false }) as string);
}

// An instance of its own, configured once: a config passed to each `sanitize` call is parsed again on every call.
let purifier: ReturnType<typeof DOMPurify> | undefined;
function sanitize(html: string): string {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.setConfig({ ADD_ATTR: ["data-lang", "data-copy", "data-visual", "data-file", "data-card", "data-kind", "data-path", "data-image", "data-width", "data-height"], FORBID_TAGS: ["style", "form", "input"] });
  }
  return purifier.sanitize(html);
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return sanitize(markdownToHtml(source, options));
}

/**
 * A top-level block that renders and sanitizes on its own: one token (with the blank lines after it), or several when
 * raw HTML in the first leaves a tag open, so `<details>` and what it wraps stay together.
 */
export interface MarkdownBlock {
  raw: string;
  tokens: Token[];
}

/** A lexed text, which the next, longer text of the same stream lexes on from (`lexMarkdown`). */
export interface LexedMarkdown {
  text: string;
  blocks: MarkdownBlock[];
  /**
   * Where each block starts in `text`, up to the first block whose source marked rewrote (it trims the last list item of
   * an unfinished text, say); the blocks before that one cover the text exactly, as reuse needs.
   */
  starts: number[];
  /** Link reference definitions, which reach across blocks; with any, every text is lexed whole. */
  links: string;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_TAG = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;

/** How many tags are open after `token`'s raw HTML (block or inline), starting from `depth`. */
function openTags(token: Token, depth: number): number {
  marked.walkTokens([token], (inner) => {
    if (inner.type !== "html") return;
    for (const [, close, name, selfClosing] of (inner as Tokens.HTML).text.matchAll(HTML_TAG)) {
      if (selfClosing || VOID_TAGS.has((name as string).toLowerCase())) continue;
      depth = Math.max(0, depth + (close ? -1 : 1));
    }
  });
  return depth;
}

/** Groups the tokens of `text` lexed from `at` into blocks, with the offset each starts at while they match the text. */
function groupBlocks(tokens: Token[], text: string, at: number): { blocks: MarkdownBlock[]; starts: number[] } {
  const blocks: MarkdownBlock[] = [];
  const starts: number[] = [];
  let exact = true;
  let open: MarkdownBlock | undefined;
  let depth = 0;
  for (const token of tokens) {
    exact &&= text.startsWith(token.raw, at);
    const blank = token.type === "space" || token.type === "def";
    // Blank lines and definitions render nothing and go with the block before them.
    const block = open ?? (blank ? blocks.at(-1) : undefined);
    if (block) {
      block.raw += token.raw;
      block.tokens.push(token);
    } else {
      open = { raw: token.raw, tokens: [token] };
      blocks.push(open);
      if (exact) starts.push(at);
    }
    at += token.raw.length;
    if (!blank) depth = openTags(token, depth);
    if (depth === 0 && !blank) open = undefined;
  }
  return { blocks, starts };
}

/**
 * The blocks of `source`. Given the text before it in the same stream, it keeps every block but the last two and lexes
 * only from there on: a block is final once another follows it (the last one can still turn into a setext heading, a
 * table or a longer list), and the one more covers a block that the new text joins to the last.
 */
export function lexMarkdown(source: string, previous?: LexedMarkdown): LexedMarkdown {
  const text = source.replace(/\r\n?/g, "\n");
  if (previous?.text === text) return previous;
  const keep = previous && !previous.links && text.startsWith(previous.text) ? Math.min(previous.blocks.length - 2, previous.starts.length - 1) : 0;
  if (previous && keep > 0) {
    const offset = previous.starts[keep] as number;
    const tokens = marked.lexer(text.slice(offset));
    if (Object.keys(tokens.links).length === 0) {
      const tail = groupBlocks(tokens, text, offset);
      return { text, blocks: [...previous.blocks.slice(0, keep), ...tail.blocks], starts: [...previous.starts.slice(0, keep), ...tail.starts], links: "" };
    }
  }
  const tokens = marked.lexer(text);
  const links = Object.keys(tokens.links).length ? JSON.stringify(tokens.links) : "";
  return { text, ...groupBlocks(tokens, text, 0), links };
}

/** One block -> HTML before sanitizing (exported for tests); a text's blocks join to its `markdownToHtml`. */
export function markdownBlockToHtml(block: MarkdownBlock, options: MarkdownOptions = {}): string {
  return withOptions(options, () => marked.parser(block.tokens));
}

const flagsOf = (options: MarkdownOptions) => `${options.visuals === true ? 1 : 0}${options.fileLinks !== false ? 1 : 0}${options.localImages === true ? 1 : 0}`;

// Sanitized HTML per block object and options: a stream keeps its blocks from frame to frame, so each renders once.
const htmlOfBlock = new WeakMap<MarkdownBlock, { flags: string; html: string }>();

/** The sanitized HTML of each block of `lexed`, in order; joined, they are `renderMarkdown` of its text. */
export function renderMarkdownBlocks(lexed: LexedMarkdown, options: MarkdownOptions = {}): string[] {
  const flags = flagsOf(options) + lexed.links;
  return lexed.blocks.map((block) => {
    const known = htmlOfBlock.get(block);
    if (known?.flags === flags) return known.html;
    const html = sanitize(markdownBlockToHtml(block, options));
    htmlOfBlock.set(block, { flags, html });
    return html;
  });
}

// Sanitized HTML of whole texts by options and source, most recently used last, within a budget of characters (source
// and HTML): a chat opened again shows its answers without rendering them again.
const textCache = new Map<string, string>();
const TEXT_CACHE_CHARS = 6_000_000;
let textCacheChars = 0;

/** `renderMarkdown`, remembered: for finished texts, which render whole (one sanitize call costs less than one per block). */
export function renderMarkdownCached(source: string, options: MarkdownOptions = {}): string {
  const key = `${flagsOf(options)}\0${source}`;
  let html = textCache.get(key);
  if (html !== undefined) {
    textCache.delete(key);
  } else {
    html = renderMarkdown(source, options);
    if (key.length + html.length > TEXT_CACHE_CHARS / 8) return html;
    textCacheChars += key.length + html.length;
    for (const [oldest, value] of textCache) {
      if (textCacheChars <= TEXT_CACHE_CHARS) break;
      textCache.delete(oldest);
      textCacheChars -= oldest.length + value.length;
    }
  }
  textCache.set(key, html);
  return html;
}
