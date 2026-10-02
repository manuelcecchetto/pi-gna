// Markdown -> sanitized HTML. Model output is untrusted: DOMPurify always runs, remote images are
// blocked by CSP, and links open outside the app.
import DOMPurify from "dompurify";
import { Marked } from "marked";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const label = escapeHtml((lang ?? "").split(/\s/)[0] || "text");
      return `<div class="code-block"><header><span>${label}</span><button type="button" data-copy>Copy</button></header><pre><code data-lang="${label}">${escapeHtml(text)}</code></pre></div>`;
    },
    // Task lists: a styled box instead of an <input>, which the sanitizer strips.
    checkbox({ checked }) {
      return `<span class="task-box${checked ? " done" : ""}" aria-hidden="true"></span>`;
    },
  },
});

/** Markdown -> HTML before sanitizing (exported for tests). */
export function markdownToHtml(source: string): string {
  return marked.parse(source, { async: false }) as string;
}

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(markdownToHtml(source), { ADD_ATTR: ["data-lang", "data-copy"], FORBID_TAGS: ["style", "form", "input"] });
}
