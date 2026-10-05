// Markdown -> sanitized HTML. Model output is untrusted: DOMPurify always runs, remote images are
// blocked by CSP, and web links open outside the app, local file links
// become `data-file` chips the component wires to the file preview (docs/FILE_PREVIEW.md, Chat links).
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { isLocalLinkHref, kindFor, looksLikePath, parseLinkTarget } from "../../../shared/preview";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

export interface MarkdownOptions {
  /** Turn complete ```visual fences into placeholders for the sandboxed frame. */
  visuals?: boolean;
}

/** Fragment cap, shared with the frame host (docs/DESIGN.md, Visuals). */
export const VISUAL_MAX_BYTES = 64 * 1024;

// marked renderers have no per-call options, so markdownToHtml sets this around each synchronous parse.
let visualsOn = false;

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
      if (!isLocalLinkHref(href)) return false;
      const kind = kindFor(parseLinkTarget(href, "/")?.path ?? href);
      return `<span class="file-link" role="link" tabindex="0" data-file="${escapeHtml(href.trim())}" data-kind="${kind}">${this.parser.parseInline(tokens)}</span>`;
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

/** Markdown -> HTML before sanitizing (exported for tests). */
export function markdownToHtml(source: string, options: MarkdownOptions = {}): string {
  visualsOn = options.visuals === true;
  try {
    return marked.parse(source, { async: false }) as string;
  } finally {
    visualsOn = false;
  }
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return DOMPurify.sanitize(markdownToHtml(source, options), { ADD_ATTR: ["data-lang", "data-copy", "data-visual", "data-file", "data-kind", "data-path"], FORBID_TAGS: ["style", "form", "input"] });
}
