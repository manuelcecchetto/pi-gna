// Code, text and JSON view: shiki-highlighted lines with a gutter, a soft-wrap toggle, and a jump to `source.line`.
// Big files stay responsive: highlighting is skipped above PREVIEW_LIMITS.highlight/highlightLines and only the first
// PREVIEW_LIMITS.text bytes are ever read (with a notice).
import { highlight } from "../renderer/src/lib/highlight";
import { PREVIEW_LIMITS, languageFor } from "../shared/preview";
import { escapeHtml, formatBytes, lineFromHash, splitLines } from "./format";
import { app, readBytes, showMessage, type Source } from "./shell";

const WRAP_KEY = "pigna-preview-wrap";

function plainLines(lines: string[]): string {
  return lines.map((line) => `<span class="line">${escapeHtml(line)}</span>`).join("");
}

/** Pretty-printed JSON for rendered mode; the text itself when it does not parse (JSONC, truncated). */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export async function showText(source: Source): Promise<void> {
  const file = await readBytes(source.rawUrl, PREVIEW_LIMITS.text);
  if (file.total === 0) return showMessage("This file is empty.", source.name);
  const cut = file.total > file.data.length;
  let text = new TextDecoder().decode(file.data, { stream: true });
  const pretty = source.kind === "json" && source.mode === "rendered" && !cut;
  if (pretty) text = prettyJson(text);
  const lines = splitLines(text);
  const lang = source.kind === "text" ? undefined : languageFor(source.name);
  const canHighlight = !!lang && text.length <= PREVIEW_LIMITS.highlight && lines.length <= PREVIEW_LIMITS.highlightLines;

  const bar = document.createElement("div");
  bar.className = "bar";
  const summary = document.createElement("span");
  summary.className = "grow";
  const notes = [`${lines.length.toLocaleString("en-US")} line${lines.length === 1 ? "" : "s"}`, formatBytes(file.total)];
  if (cut) notes.push(`showing the first ${formatBytes(file.data.length)}; Open with default app for the rest`);
  else if (lang && !canHighlight) notes.push("too large to highlight");
  summary.textContent = notes.join(" · ");
  const wrapButton = document.createElement("button");
  wrapButton.type = "button";
  wrapButton.textContent = "Wrap";
  bar.append(summary, wrapButton);

  const scroller = document.createElement("div");
  scroller.className = "scroller";
  const code = document.createElement("code");
  code.className = "code hl";
  code.style.setProperty("--gutter", `${String(lines.length).length + 2}ch`);
  code.innerHTML = plainLines(lines);
  const pre = document.createElement("pre");
  pre.append(code);
  scroller.append(pre);
  app.replaceChildren(bar, scroller);

  const setWrap = (on: boolean): void => {
    scroller.classList.toggle("wrap", on);
    wrapButton.classList.toggle("on", on);
    wrapButton.setAttribute("aria-pressed", String(on));
  };
  let wrap = sessionStorage.getItem(WRAP_KEY) === "1";
  setWrap(wrap);
  wrapButton.addEventListener("click", () => {
    wrap = !wrap;
    sessionStorage.setItem(WRAP_KEY, wrap ? "1" : "0");
    setWrap(wrap);
  });

  // The jump target survives re-highlighting, which replaces the line elements.
  const line = source.line ?? lineFromHash(window.location.hash);
  const jump = (): void => {
    if (!line) return;
    code.querySelector(".target")?.classList.remove("target");
    const element = code.children[Math.min(line, lines.length) - 1];
    element?.classList.add("target");
    element?.scrollIntoView({ block: "center" });
  };
  const SCROLL_KEY = `pigna-preview-scroll:${source.name}`;
  if (line) jump();
  else scroller.scrollTop = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
  let pending = false;
  scroller.addEventListener("scroll", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      sessionStorage.setItem(SCROLL_KEY, String(scroller.scrollTop));
    });
  });

  if (canHighlight) {
    const html = await highlight(text, lang, PREVIEW_LIMITS.highlight).catch(() => undefined);
    // Shiki emits one `.line` span per line, separated by newlines that would render as blank lines in blocks.
    if (html && code.isConnected) {
      code.innerHTML = html.replaceAll("\n", "");
      jump();
    }
  }
}
