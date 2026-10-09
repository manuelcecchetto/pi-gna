// Code, text and JSON view: shiki-highlighted lines with a gutter, a soft-wrap toggle, and a jump to `source.line`.
// Big files stay responsive: the lines go in blocks of BLOCK_LINES that skip style and layout while off screen
// (content-visibility), highlighting runs a slice at a time and swaps a block in once its lines are done, it is
// skipped above PREVIEW_LIMITS.highlight/highlightLines, and only the first PREVIEW_LIMITS.text bytes are ever read
// (with a notice).
import { highlightLines } from "../renderer/src/lib/highlight";
import { PREVIEW_LIMITS, languageFor } from "../shared/preview";
import { escapeHtml, formatBytes, lineFromHash, splitLines } from "./format";
import { app, readBytes, showMessage, type Source } from "./shell";

const WRAP_KEY = "pigna-preview-wrap";
/** Lines per block: a block off screen costs no style or layout, and highlighting swaps in a block at a time. */
export const BLOCK_LINES = 200;
/** Lines this long stay plain: shiki would spend up to a second on one minified line, in one task. */
const PLAIN_LINE = 5_000;

/** A block's lines as `.line` spans, escaped in one pass. */
export function plainLines(lines: string[]): string {
  return `<span class="line">${escapeHtml(lines.join("\n")).replaceAll("\n", '</span><span class="line">')}</span>`;
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
  // The longest line sets the width up front: a block off screen adds none of its own.
  code.style.setProperty("--columns", String(lines.reduce((most, line) => Math.max(most, line.length), 0)));
  const blocks: HTMLElement[] = [];
  for (let from = 0; from < lines.length; from += BLOCK_LINES) {
    const part = lines.slice(from, from + BLOCK_LINES);
    const block = document.createElement("div");
    block.className = "block";
    block.style.setProperty("--from", String(from));
    block.style.setProperty("--lines", String(part.length));
    block.innerHTML = plainLines(part);
    blocks.push(block);
  }
  code.append(...blocks);
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

  // The jump target is marked again when highlighting swaps in its block.
  const asked = source.line ?? lineFromHash(window.location.hash);
  const line = asked && Math.min(asked, lines.length);
  const mark = (): Element | undefined => {
    if (!line) return undefined;
    const element = blocks[Math.floor((line - 1) / BLOCK_LINES)]?.children[(line - 1) % BLOCK_LINES];
    element?.classList.add("target");
    return element;
  };
  const SCROLL_KEY = `pigna-preview-scroll:${source.name}`;
  if (line) mark()?.scrollIntoView({ block: "center" });
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
    // Highlighted lines come in order; a block is swapped in once all of its lines are done.
    let done: string[] = [];
    let next = 0;
    await highlightLines(text, lang, PLAIN_LINE, (slice) => {
      if (!code.isConnected) return false;
      for (const html of slice) {
        const block = blocks[next];
        // A trailing newline gives shiki one more (empty) line than the plain view numbers.
        if (!block) return false;
        done.push(html);
        if (done.length < block.childElementCount) continue;
        block.innerHTML = done.join("");
        done = [];
        next++;
        mark();
      }
      return true;
    }).catch(() => false);
  }
}
