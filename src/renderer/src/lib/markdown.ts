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
  },
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-lang", "data-copy"], FORBID_TAGS: ["style", "form", "input"] });
}
