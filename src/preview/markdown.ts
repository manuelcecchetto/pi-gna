// Rendered Markdown: marked (GFM) + DOMPurify from the app's own pipeline, shiki fences, heading anchors, a table of
// contents for long documents and links/images resolved against the preview origin. The file is untrusted; the
// viewer CSP additionally blocks remote images and any script.
import { highlightWithin } from "../renderer/src/lib/highlight";
import { renderMarkdown } from "../renderer/src/lib/markdown";
import { PREVIEW_LIMITS } from "../shared/preview";
import { classifyLink, resolveImage, slugify, splitFrontMatter } from "./links";
import { app, readBytes, showMessage, type Source } from "./shell";
import { formatBytes } from "./format";

const TOC_MIN_HEADINGS = 4;

function frontMatterTable(entries: [string, string][]): HTMLElement {
  const table = document.createElement("table");
  table.className = "front-matter";
  for (const [key, value] of entries) {
    const row = table.insertRow();
    const head = document.createElement("th");
    head.textContent = key;
    row.append(head);
    row.insertCell().textContent = value;
  }
  return table;
}

/** Give headings ids and return the table of contents entries. */
function anchorHeadings(root: HTMLElement): { id: string; text: string; level: number }[] {
  const seen = new Map<string, number>();
  const list: { id: string; text: string; level: number }[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const text = heading.textContent ?? "";
    heading.id = slugify(text, seen);
    const link = document.createElement("a");
    link.className = "anchor";
    link.href = `#${heading.id}`;
    link.setAttribute("aria-label", "Link to this section");
    link.textContent = "#";
    heading.append(link);
    list.push({ id: heading.id, text, level: Number(heading.tagName.slice(1)) });
  }
  return list;
}

function resolveAssets(root: HTMLElement): void {
  const base = window.location.href;
  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    const result = resolveImage(src, base);
    if (result.type === "local" || result.type === "data") {
      image.src = result.url;
      image.loading = "lazy";
    } else {
      // Remote images are blocked by the viewer CSP; keep the alt text so the document still reads.
      const note = document.createElement("span");
      note.className = "image-blocked";
      note.textContent = image.alt || (result.type === "remote" ? "remote image" : "image");
      if (result.type === "remote") note.title = `Not loaded: ${src}`;
      image.replaceWith(note);
    }
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.classList.contains("anchor")) continue;
    const target = classifyLink(link.getAttribute("href") ?? "", base);
    link.removeAttribute("target");
    if (target.type === "anchor") link.setAttribute("href", `#${target.id}`);
    else if (target.type === "local" || target.type === "mail") link.setAttribute("href", target.url);
    else if (target.type === "web") {
      link.setAttribute("href", target.url);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else link.removeAttribute("href");
  }
}

function scrollToAnchor(id: string): void {
  const element = document.getElementById(id) ?? document.getElementsByName(id)[0];
  element?.scrollIntoView({ block: "start" });
}

function toc(entries: { id: string; text: string; level: number }[]): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "toc";
  const top = Math.min(...entries.map((entry) => entry.level));
  for (const entry of entries) {
    if (entry.level > top + 2) continue;
    const link = document.createElement("a");
    link.href = `#${entry.id}`;
    link.textContent = entry.text;
    link.style.paddingLeft = `${(entry.level - top) * 12}px`;
    nav.append(link);
  }
  return nav;
}

/** Offer the other mode: raw is the same page with `?view=raw`. */
function modeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Source";
  button.title = "Show the Markdown source";
  button.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "raw");
    url.hash = "";
    window.location.href = url.href;
  });
  return button;
}

export async function showMarkdown(source: Source): Promise<void> {
  const file = await readBytes(source.rawUrl, PREVIEW_LIMITS.text);
  if (file.total === 0) return showMessage("This file is empty.", source.name);
  const cut = file.total > file.data.length;
  const { entries, body } = splitFrontMatter(new TextDecoder().decode(file.data, { stream: true }));

  const article = document.createElement("article");
  article.className = "prose";
  article.innerHTML = renderMarkdown(body);
  const headings = anchorHeadings(article);
  resolveAssets(article);
  if (entries.length) article.prepend(frontMatterTable(entries));
  if (headings.length >= TOC_MIN_HEADINGS) {
    const details = document.createElement("details");
    details.className = "toc-box";
    const summary = document.createElement("summary");
    summary.textContent = "Contents";
    details.append(summary, toc(headings));
    article.prepend(details);
  }

  const bar = document.createElement("div");
  bar.className = "bar";
  const summary = document.createElement("span");
  summary.className = "grow";
  summary.textContent = cut ? `${formatBytes(file.total)} · showing the first ${formatBytes(file.data.length)}; switch to Source or open with the default app for the rest` : formatBytes(file.total);
  bar.append(summary, modeButton());

  const scroller = document.createElement("div");
  scroller.className = "scroller";
  scroller.append(article);
  app.replaceChildren(bar, scroller);

  article.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const copy = target?.closest<HTMLElement>("button[data-copy]");
    if (copy) {
      const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).catch(() => undefined);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
      return;
    }
    const link = target?.closest<HTMLAnchorElement>("a[href^='#']");
    if (link) {
      event.preventDefault();
      scrollToAnchor(decodeURIComponent(link.getAttribute("href")!.slice(1)));
    }
  });
  highlightWithin(article);
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (hash) scrollToAnchor(hash);
}
