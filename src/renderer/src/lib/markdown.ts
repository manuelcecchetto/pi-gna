// Markdown -> sanitized HTML. Model output is untrusted: DOMPurify always runs, remote images are
// blocked by CSP, and links open outside the app.
import DOMPurify from "dompurify";
import { Marked } from "marked";

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
  return DOMPurify.sanitize(markdownToHtml(source, options), { ADD_ATTR: ["data-lang", "data-copy", "data-visual"], FORBID_TAGS: ["style", "form", "input"] });
}
