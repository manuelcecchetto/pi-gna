// PDF view: pdf.js draws the pages (canvas, plus a text layer so text selects, searches and reads in the agent's
// snapshot); every control is ours: page n / m with prev/next and zoom (Fit, -/+, ctrl/cmd+wheel) in the bar, and a find
// card over the pages that only Cmd/Ctrl+F opens (Escape closes it).
// Chromium's PDF plugin is not used, so nothing of its toolbar or thumbnail rail shows. Bytes come from `?raw=1` with
// Range requests (pdf.js loads large files in chunks). Scripting, forms editing and annotation editors stay off.
// Loaded lazily so other kinds do not pay for pdf.js. Design: docs/FILE_PREVIEW.md.
import "pdfjs-dist/web/pdf_viewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { formatBytes, pageFromHash } from "./format";
import { app, readBytes, showMessage, type Source } from "./shell";

/** pdf.js data files copied next to the bundle by vite.preview.config.ts (`pdfjs/`). */
const ASSETS = "/__viewer/pdfjs/";
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
/** pdf.js preset: page width, but never above 125%. */
const FIT = "auto";

const SVG = "http://www.w3.org/2000/svg";

/** A borderless icon button with a chevron pointing up or down. */
function chevron(direction: "up" | "down", title: string): HTMLButtonElement {
  const el = button("", title, "pdf-icon");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", direction === "up" ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4");
  svg.append(path);
  el.append(svg);
  return el;
}

function button(label: string, title: string, className = ""): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.title = title;
  el.setAttribute("aria-label", title);
  if (className) el.className = className;
  return el;
}

export async function showPdf(source: Source): Promise<void> {
  const head = await readBytes(source.rawUrl, 5);
  if (head.total === 0) return showMessage("This PDF is empty", source.name);

  showMessage("Opening PDF…", source.name);
  const pdfjs = await import("pdfjs-dist");
  // The viewer components read the core library from this global when their module is evaluated.
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;
  const { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } = await import("pdfjs-dist/web/pdf_viewer.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const origin = window.location.origin;
  const task = pdfjs.getDocument({
    url: source.rawUrl,
    cMapUrl: `${origin}${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${origin}${ASSETS}standard_fonts/`,
    wasmUrl: `${origin}${ASSETS}wasm/`,
    iccUrl: `${origin}${ASSETS}iccs/`,
    enableXfa: false,
  });
  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") return showMessage("This PDF is password-protected", "To open it elsewhere, right-click the tab and choose Open with default app.");
    if (name === "InvalidPDFException") return showMessage("Can't show this file", "It is not a valid PDF (it may be corrupt).", "error");
    return showMessage("Can't show this file", "The PDF could not be read.", "error");
  }

  const bar = document.createElement("div");
  bar.className = "bar pdf-bar";
  const nav = document.createElement("span");
  nav.className = "pdf-group pdf-nav";
  const prev = button("‹", "Previous page");
  const next = button("›", "Next page");
  const pageInput = document.createElement("input");
  pageInput.className = "pdf-page";
  pageInput.inputMode = "numeric";
  pageInput.setAttribute("aria-label", "Page");
  pageInput.value = "1";
  const count = document.createElement("span");
  count.textContent = `/ ${pdf.numPages}`;
  nav.append(prev, pageInput, count, next);

  // Find: a card floating over the pages, hidden until Cmd/Ctrl+F.
  const find = document.createElement("div");
  find.className = "pdf-find";
  find.hidden = true;
  const query = document.createElement("input");
  query.type = "text";
  query.placeholder = "Find";
  query.spellcheck = false;
  query.setAttribute("aria-label", "Find in document");
  const matches = document.createElement("span");
  matches.className = "pdf-matches";
  const findPrev = chevron("up", "Previous match (Shift+Enter)");
  const findNext = chevron("down", "Next match (Enter)");
  find.append(query, matches, findPrev, findNext);

  const zoom = document.createElement("span");
  zoom.className = "pdf-group pdf-zoom";
  const out = button("−", "Zoom out");
  const level = button("Fit", "Fit to width");
  const inn = button("+", "Zoom in");
  zoom.append(out, level, inn);

  const spacer = document.createElement("span");
  spacer.className = "grow";
  const size = document.createElement("span");
  size.className = "pdf-size";
  size.textContent = formatBytes(head.total);
  bar.append(nav, spacer, zoom, size);

  // PDFViewer requires an absolutely positioned scroll container around its `.pdfViewer` element.
  const stage = document.createElement("div");
  stage.className = "pdf-stage";
  const container = document.createElement("div");
  container.className = "pdf-scroll";
  container.tabIndex = 0;
  const viewerEl = document.createElement("div");
  viewerEl.className = "pdfViewer";
  container.append(viewerEl);
  stage.append(container, find);
  app.replaceChildren(bar, stage);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: "noopener noreferrer" });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, removePageBorders: true });
  linkService.setViewer(viewer);

  const SCROLL_KEY = `pigna-preview-pdf:${window.location.pathname}`;
  const target = pageFromHash(window.location.hash, source.line);
  eventBus.on("pagesinit", () => {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    viewer.currentScaleValue = FIT;
    if (target) viewer.currentPageNumber = Math.min(target, pdf.numPages);
    else if (saved) {
      // A live reload keeps the zoom and position.
      const { scale, top } = JSON.parse(saved) as { scale: string; top: number };
      viewer.currentScaleValue = scale;
      container.scrollTop = top;
    }
    container.focus({ preventScroll: true });
  });
  let pending = false;
  container.addEventListener("scroll", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ scale: viewer.currentScaleValue, top: container.scrollTop }));
    });
  });

  // Pages.
  const syncPage = (page: number): void => {
    pageInput.value = String(page);
    prev.disabled = page <= 1;
    next.disabled = page >= pdf.numPages;
  };
  eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => syncPage(pageNumber));
  syncPage(1);
  prev.addEventListener("click", () => viewer.previousPage());
  next.addEventListener("click", () => viewer.nextPage());
  pageInput.addEventListener("focus", () => pageInput.select());
  pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const page = Number.parseInt(pageInput.value, 10);
      if (page >= 1 && page <= pdf.numPages) viewer.currentPageNumber = page;
      syncPage(viewer.currentPageNumber);
      container.focus({ preventScroll: true });
    } else if (event.key === "Escape") {
      syncPage(viewer.currentPageNumber);
      container.focus({ preventScroll: true });
    }
  });
  pageInput.addEventListener("blur", () => syncPage(viewer.currentPageNumber));

  // Zoom.
  const syncZoom = (): void => {
    const fit = viewer.currentScaleValue === FIT;
    level.textContent = fit ? "Fit" : `${Math.round(viewer.currentScale * 100)}%`;
    level.classList.toggle("on", fit);
    out.disabled = viewer.currentScale <= MIN_SCALE;
    inn.disabled = viewer.currentScale >= MAX_SCALE;
  };
  eventBus.on("scalechanging", syncZoom);
  const step = (factor: number): void => {
    viewer.currentScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewer.currentScale * factor));
  };
  out.addEventListener("click", () => step(1 / 1.2));
  inn.addEventListener("click", () => step(1.2));
  level.addEventListener("click", () => {
    viewer.currentScaleValue = FIT;
  });
  container.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      step(Math.exp(-event.deltaY / 200));
    },
    { passive: false },
  );
  // A narrower or wider pane re-fits; an explicit zoom stays.
  new ResizeObserver(() => {
    if (viewer.currentScaleValue === FIT) viewer.currentScaleValue = FIT;
  }).observe(container);

  // Find.
  const search = (type: "" | "again", findPrevious = false): void => {
    eventBus.dispatch("find", { source: query, type, query: query.value, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false });
  };
  const showCount = ({ current, total }: { current: number; total: number }): void => {
    matches.textContent = total > 0 ? `${current} of ${total}` : "";
  };
  eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => showCount(matchesCount));
  eventBus.on("updatefindcontrolstate", ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
    if (state === FindState.NOT_FOUND && query.value) matches.textContent = "No matches";
    else showCount(matchesCount);
    query.classList.toggle("missing", state === FindState.NOT_FOUND && query.value !== "");
  });
  const syncFind = (): void => {
    const empty = query.value === "";
    findPrev.disabled = empty;
    findNext.disabled = empty;
    if (empty) {
      matches.textContent = "";
      query.classList.remove("missing");
    }
  };
  const openFind = (): void => {
    find.hidden = false;
    query.focus();
    query.select();
    // Reopening keeps the last query: show its highlights again.
    if (query.value) search("");
  };
  const closeFind = (): void => {
    find.hidden = true;
    eventBus.dispatch("findbarclose", { source: query });
    container.focus({ preventScroll: true });
  };
  query.addEventListener("input", () => {
    syncFind();
    if (query.value) search("");
    else eventBus.dispatch("findbarclose", { source: query });
  });
  query.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && query.value) search("again", event.shiftKey);
    else if (event.key === "Escape") closeFind();
    else return;
    event.preventDefault();
  });
  // Keep focus in the field while stepping through matches.
  for (const el of [findPrev, findNext]) el.addEventListener("mousedown", (event) => event.preventDefault());
  findPrev.addEventListener("click", () => search("again", true));
  findNext.addEventListener("click", () => search("again"));
  syncFind();

  // Keys while reading: Cmd/Ctrl+F finds, Cmd/Ctrl+G walks matches, Escape closes find, +/-/0 zoom, arrows page when
  // nothing scrolls sideways.
  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "f") openFind();
    else if (mod && event.key.toLowerCase() === "g" && query.value) {
      if (find.hidden) find.hidden = false;
      search("again", event.shiftKey);
    } else if (event.key === "Escape" && !find.hidden) closeFind();
    else if (mod || event.altKey || event.target instanceof HTMLInputElement) return;
    else if (event.key === "+" || event.key === "=") step(1.2);
    else if (event.key === "-") step(1 / 1.2);
    else if (event.key === "0") viewer.currentScaleValue = FIT;
    else if (event.key === "ArrowLeft" && container.scrollWidth <= container.clientWidth) viewer.previousPage();
    else if (event.key === "ArrowRight" && container.scrollWidth <= container.clientWidth) viewer.nextPage();
    else return;
    event.preventDefault();
  });

  viewer.setDocument(pdf);
  linkService.setDocument(pdf);
}
