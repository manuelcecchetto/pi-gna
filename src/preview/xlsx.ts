// XLSX view: BetterOffice's spreadsheet engine builds a display list for the visible part of the sheet and paints it on
// one canvas the size of the pane; a transparent scroller over it, sized to the sheet's content, drives the viewport.
// Sheet tabs sit in the footer. The workbook's cells are kept as hidden Markdown for the agent's page snapshot.
// Design: docs/FILE_PREVIEW.md.
import { initWasm, openWorkbook, paintDisplayList, type WorkbookHandle } from "@betteroffice/xlsx";
import { formatBytes } from "./format";
import { cantRead, loadFaces, readOffice, textLayer } from "./office";
import { app, type Source } from "./shell";

export async function showXlsx(source: Source): Promise<void> {
  const [file] = await Promise.all([readOffice(source, "xlsx"), initWasm()]);
  if (!file) return;
  let book: WorkbookHandle;
  try {
    book = openWorkbook(file.data);
  } catch {
    return cantRead("workbook");
  }
  let sheet = book.sheetInfo();

  const stage = document.createElement("div");
  stage.className = "office-stage xlsx-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "xlsx-canvas";
  const scroller = document.createElement("div");
  scroller.className = "xlsx-scroll";
  scroller.tabIndex = 0;
  const size = document.createElement("div");
  scroller.append(size);
  stage.append(canvas, scroller);

  const bar = document.createElement("div");
  bar.className = "footer";
  const tabs = document.createElement("span");
  tabs.className = "xlsx-tabs";
  const info = document.createElement("span");
  info.textContent = `${sheet.sheetNames.length} ${sheet.sheetNames.length === 1 ? "sheet" : "sheets"} · ${formatBytes(file.total)}`;
  bar.append(tabs, info);

  // Office families seen in painted cells; each gets its bundled stand-in, then the sheet repaints with it.
  const families = new Set<string>();
  let frame = 0;
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  function paint(): void {
    frame = 0;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    if (!width || !height) return;
    const dpr = devicePixelRatio;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    try {
      const list = book.displayList({ x: scroller.scrollLeft, y: scroller.scrollTop, width, height });
      paintDisplayList(canvas.getContext("2d")!, list, dpr);
      if (!performance.getEntriesByName("preview:first-page").length) performance.mark("preview:first-page");
      const fresh = new Set<string>();
      for (const command of list.commands) {
        if (command.op === "text" && command.fontFamily && !command.chart && !families.has(command.fontFamily)) fresh.add(command.fontFamily);
      }
      if (fresh.size) {
        fresh.forEach((family) => families.add(family));
        void loadFaces(fresh, false).then(schedule);
      }
    } catch (error) {
      console.warn("[xlsx] paint", error);
    }
  }

  const select = (index: number): void => {
    try {
      book.setActiveSheet(index);
    } catch (error) {
      console.warn("[xlsx] sheet", index, error);
      return;
    }
    sheet = book.sheetInfo();
    size.style.width = `${sheet.contentWidth}px`;
    size.style.height = `${sheet.contentHeight}px`;
    scroller.scrollTo(sheet.initialScrollX, sheet.initialScrollY);
    [...tabs.children].forEach((tab, i) => tab.classList.toggle("on", i === index));
    schedule();
  };
  sheet.sheetNames.forEach((name, index) => {
    const tab = document.createElement("button");
    tab.textContent = name;
    tab.title = name;
    tab.addEventListener("click", () => select(index));
    tabs.append(tab);
  });

  scroller.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(scroller);
  app.replaceChildren(stage, bar);
  select(sheet.activeSheet);
  scroller.focus({ preventScroll: true });
  try {
    const result = book.exportMarkdown();
    if (result.ok) app.append(textLayer("Workbook cells", result.content.markdown));
  } catch {
    // The canvas still shows the sheet; only the snapshot text is missing.
  }
}
