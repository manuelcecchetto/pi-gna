// DOCX view: BetterOffice's DocxEditor paints the pages on canvas, read-only. It opens the file in its resident worker and
// paints a preview of the first page before the whole document is open, so a long document shows in about a second and
// the page stays responsive while the rest is laid out; the footer says "Laying out" until the page count is known.
// Loaded lazily (React, the engine and its wasm are only fetched for a .docx). Design: docs/FILE_PREVIEW.md.
import { setGoogleFontsEnabled } from "@betteroffice/docx";
import { DocxEditor, configureDefaultFonts, type DocxEditorRef } from "@betteroffice/docx-react";
import "@betteroffice/docx-react/styles.css";
import * as fonts from "@betteroffice/fonts";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { formatBytes } from "./format";
import { cantRead, readOffice, spinner, textLayer } from "./office";
import { app, type Source } from "./shell";

// Fonts come from the bundled set, same-origin; the viewer's CSP allows no other host.
setGoogleFontsEnabled(false);
configureDefaultFonts({ fonts });

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

/** Errors BetterOffice reports without failing the open, e.g. a CJK face that is not bundled. */
const harmless = (error: Error): boolean => /\bfont\b/i.test(error.message);

export async function showDocx(source: Source): Promise<void> {
  const file = await readOffice(source, "docx");
  if (!file) return;

  const stage = document.createElement("div");
  stage.className = "docx-stage";
  const host = document.createElement("div");
  host.className = "docx-host";
  const veil = document.createElement("div");
  veil.className = "message veil";
  const title = document.createElement("div");
  title.className = "message-title";
  title.textContent = "Opening document…";
  const detail = document.createElement("div");
  detail.className = "message-detail";
  detail.textContent = source.name;
  veil.append(spinner(), title, detail);
  stage.append(host, veil);

  const bar = document.createElement("div");
  bar.className = "footer";
  const info = document.createElement("span");
  info.className = "office-status";
  info.textContent = `Opening… · ${formatBytes(file.total)}`;
  const controls = document.createElement("span");
  controls.className = "docx-zoom";
  const button = (label: string, tip: string): HTMLButtonElement => {
    const el = document.createElement("button");
    el.textContent = label;
    el.title = tip;
    return el;
  };
  const out = button("−", "Zoom out");
  const level = button("Fit", "Fit to width");
  const inn = button("+", "Zoom in");
  controls.append(out, level, inn);
  bar.append(info, controls);
  app.replaceChildren(stage, bar);

  const ref = createRef<DocxEditorRef>();
  const root = createRoot(host);
  let painted = false;
  let failed = false;
  const fail = (): void => {
    if (failed) return;
    failed = true;
    root.unmount();
    cantRead("document");
  };

  let scale: "fit" | number = "fit";
  /** Width of a page at zoom 1, from the painted page and the zoom it was painted at. */
  const pageWidth = (): number => {
    const page = host.querySelector<HTMLElement>(".canvas-page");
    const zoom = ref.current?.getZoom() ?? 1;
    return page ? page.getBoundingClientRect().width / zoom : 816;
  };
  const effective = (): number => (scale === "fit" ? Math.min(1.5, Math.max(MIN_ZOOM, (stage.clientWidth - 48) / pageWidth())) : scale);
  const apply = (): void => {
    if (!painted) return;
    ref.current?.setZoom(effective());
    level.textContent = scale === "fit" ? "Fit" : `${Math.round(scale * 100)}%`;
    level.classList.toggle("on", scale === "fit");
  };
  const step = (factor: number): void => {
    scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, effective() * factor));
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
    { passive: false, capture: true },
  );
  new ResizeObserver(() => scale === "fit" && apply()).observe(stage);

  // The page DOM BetterOffice mirrors for hit-testing is per glyph and only near the viewport, so the agent's page
  // snapshot reads the text from an export instead, started once the layout no longer competes for the CPU.
  const readText = (): void => {
    const worker = new Worker(new URL("./docx-text.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => {
      worker.terminate();
      if (event.data.text !== undefined) app.append(textLayer("Document text", event.data.text));
      else console.warn("[docx] text", event.data.error);
    };
    worker.postMessage(file.data);
  };

  const firstPage = (): void => {
    if (painted || failed) return;
    painted = true;
    performance.mark("preview:first-page");
    veil.remove();
    apply();
    info.replaceChildren(spinner(), `Laying out… · ${formatBytes(file.total)}`);
    void ref.current
      ?.whenLayoutComplete()
      .then((pages) => {
        performance.mark("preview:laid-out");
        info.textContent = `${pages} ${pages === 1 ? "page" : "pages"} · ${formatBytes(file.total)}`;
        if (scale === "fit") apply();
        readText();
      })
      .catch((error: unknown) => {
        console.warn("[docx] layout", error);
        info.textContent = formatBytes(file.total);
      });
  };

  // Tracked changes show inline on the pages. BetterOffice's comments and changes sidebar needs a column beside the
  // page that a preview pane does not have, so it stays closed.
  root.render(
    <DocxEditor
      ref={ref}
      documentBuffer={file.data}
      mode="viewing"
      readOnly
      showToolbar={false}
      showRuler={false}
      showZoomControl={false}
      showOutlineButton={false}
      showFileOpen={false}
      showHelpMenu={false}
      colorMode="system"
      commentsSidebarOpen={false}
      experimentalWorkerOpen
      previewFirstPage
      onFirstPagePainted={firstPage}
      onError={(error) => {
        if (painted || harmless(error)) console.warn("[docx]", error.message);
        else fail();
      }}
    />,
  );
}
