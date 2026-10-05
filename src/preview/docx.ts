// DOCX view: docx-preview builds the pages (size, margins, header/footer, tables, images, lists) as DOM nodes, so no
// file markup is ever parsed as HTML. Pages stay white on a neutral surround; Fit scales them to the pane width and
// +/- (or ctrl/cmd+wheel) zoom. Loaded lazily so other kinds do not pay for it.
import { PREVIEW_LIMITS } from "../shared/preview";
import { formatBytes } from "./format";
import { app, readBytes, showMessage, type Source } from "./shell";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

/** What the first bytes say: a zip (a real .docx), an OLE container (legacy .doc or an encrypted .docx), or neither. */
function container(data: Uint8Array): "zip" | "ole" | "unknown" {
  if (data[0] === 0x50 && data[1] === 0x4b) return "zip";
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return "ole";
  return "unknown";
}

export async function showDocx(source: Source): Promise<void> {
  const head = await readBytes(source.rawUrl, 8);
  if (head.total === 0) return showMessage("This document is empty", source.name);
  if (head.total > PREVIEW_LIMITS.docx) {
    return showMessage("This document is too large to preview", `${formatBytes(head.total)} is over the ${formatBytes(PREVIEW_LIMITS.docx)} limit. Use Open with default app in the toolbar.`);
  }
  const kind = container(head.data);
  if (kind === "ole") {
    return showMessage("Can't preview this document", "It is a legacy Word file or a password-protected document. Use Open with default app in the toolbar.");
  }
  if (kind === "unknown") return showMessage("Can't show this file", "It is not a valid .docx document (it may be corrupt).", "error");

  showMessage("Rendering document…", source.name);
  const file = await readBytes(source.rawUrl, PREVIEW_LIMITS.docx);
  const { renderAsync } = await import("docx-preview");

  const stage = document.createElement("div");
  stage.className = "docx-stage";
  stage.tabIndex = 0;
  const pages = document.createElement("div");
  pages.className = "docx-pages";
  stage.append(pages);
  const bar = document.createElement("div");
  bar.className = "footer";
  const info = document.createElement("span");
  const controls = document.createElement("span");
  controls.className = "docx-zoom";
  const button = (label: string, title: string): HTMLButtonElement => {
    const el = document.createElement("button");
    el.textContent = label;
    el.title = title;
    return el;
  };
  const out = button("−", "Zoom out");
  const level = button("Fit", "Fit to width");
  const inn = button("+", "Zoom in");
  controls.append(out, level, inn);
  bar.append(info, controls);

  // Render off-screen first: a corrupt or unreadable file then leaves the loading message in place of a blank page.
  try {
    await renderAsync(file.data, pages, undefined, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderChanges: false,
      useBase64URL: true,
      ignoreWidth: false,
      ignoreHeight: false,
    });
  } catch {
    return showMessage("Can't show this file", "The document could not be read. It may be corrupt, or password-protected.", "error");
  }
  const count = pages.querySelectorAll("section.docx").length;
  if (count === 0) return showMessage("This document has no pages to show", source.name);
  app.replaceChildren(stage, bar);
  info.textContent = `${count} ${count === 1 ? "page" : "pages"} · ${formatBytes(file.total)}`;

  let scale: "fit" | number = "fit";
  const pageWidth = (): number => Math.max(...[...pages.querySelectorAll<HTMLElement>("section.docx")].map((el) => el.offsetWidth), 1);
  const effective = (): number => (scale === "fit" ? Math.min(1, Math.max(MIN_SCALE, (stage.clientWidth - 32) / pageWidth())) : scale);
  const apply = (): void => {
    pages.style.zoom = String(effective());
    level.textContent = scale === "fit" ? "Fit" : `${Math.round(scale * 100)}%`;
    level.classList.toggle("on", scale === "fit");
  };
  const step = (factor: number): void => {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, effective() * factor));
    apply();
  };
  out.addEventListener("click", () => step(1 / 1.2));
  inn.addEventListener("click", () => step(1.2));
  level.addEventListener("click", () => {
    scale = "fit";
    apply();
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      step(Math.exp(-event.deltaY / 200));
    },
    { passive: false },
  );
  stage.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") step(1.2);
    else if (event.key === "-") step(1 / 1.2);
    else if (event.key === "0") {
      scale = "fit";
      apply();
    } else return;
    event.preventDefault();
  });
  new ResizeObserver(() => scale === "fit" && apply()).observe(stage);
  apply();
  stage.focus({ preventScroll: true });
}
