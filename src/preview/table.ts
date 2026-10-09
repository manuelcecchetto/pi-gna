// CSV/TSV as a table (first PREVIEW_LIMITS.tableRows rows); raw mode is the text view. Big tables stay responsive: the
// rows go in tables of BLOCK_ROWS that skip style and layout while off screen (content-visibility), all with the
// header's column widths, worked out once from the values (fixed table layout) instead of by laying out every cell.
import { PREVIEW_LIMITS } from "../shared/preview";
import { parseCsv } from "./csv";
import { escapeHtml, formatBytes } from "./format";
import { app, readBytes, showMessage, type Source } from "./shell";

/** Rows per block: a block off screen costs no style or layout. */
export const BLOCK_ROWS = 200;
/** Widest text a column shows before an ellipsis, in pixels. */
const MAX_TEXT = 420;
/** A cell's horizontal padding and border (style.css). */
const CELL_EDGES = 21;
/** Values measured in all, the longest of each column: measuring every cell would cost about 4 µs each. */
const MEASURED = 2_000;

/** The `count` longest values of column `c`, longest first. */
export function longest(rows: string[][], c: number, count: number): string[] {
  const found: string[] = [];
  for (const row of rows) {
    const value = row[c] ?? "";
    if (found.length === count && value.length <= (found[count - 1] as string).length) continue;
    let at = found.length;
    while (at > 0 && (found[at - 1] as string).length < value.length) at--;
    found.splice(at, 0, value);
    if (found.length > count) found.pop();
  }
  return found;
}

/**
 * Each column's width in pixels: the widest of its header and its longest values (MEASURED shared out), at most
 * MAX_TEXT, plus the cell's padding and border. `measure` gives a text's width in the body font, `measureHead` in the
 * header's.
 */
export function columnWidths(header: string[], rows: string[][], columns: number, measure: (text: string) => number, measureHead: (text: string) => number): number[] {
  const count = Math.max(4, Math.floor(MEASURED / Math.max(columns, 1)));
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    let widest = measureHead(header[c] ?? "");
    for (const value of longest(rows, c, count)) widest = Math.max(widest, measure(value));
    widths.push(Math.ceil(Math.min(widest, MAX_TEXT)) + CELL_EDGES);
  }
  return widths;
}

/** Rows `from`..`to` as `<tr>`s, each opening with its row number. */
export function rowsHtml(rows: string[][], from: number, to: number, columns: number): string {
  let html = "";
  for (let r = from; r < to; r++) {
    const row = rows[r] as string[];
    html += `<tr><td class="n">${r + 1}</td>`;
    for (let c = 0; c < columns; c++) {
      const value = row[c] ?? "";
      html += `<td>${/[&<>]/.test(value) ? escapeHtml(value) : value}</td>`;
    }
    html += "</tr>";
  }
  return html;
}

export async function showTable(source: Source): Promise<void> {
  const file = await readBytes(source.rawUrl, PREVIEW_LIMITS.text);
  if (file.total === 0) return showMessage("This file is empty.");
  const text = new TextDecoder().decode(file.data, { stream: true });
  const delimiter = source.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const { rows, truncated } = parseCsv(text, delimiter, PREVIEW_LIMITS.tableRows + 1);
  const [header = [], ...body] = rows;
  const shown = body.slice(0, PREVIEW_LIMITS.tableRows);
  const columns = shown.reduce((most, row) => Math.max(most, row.length), header.length);

  const colgroup = `<colgroup>${"<col>".repeat(columns + 1)}</colgroup>`;
  const head = document.createElement("table");
  head.className = "head";
  head.innerHTML = colgroup;
  const headRow = head.createTHead().insertRow();
  headRow.append(Object.assign(document.createElement("th"), { className: "n" }));
  for (let c = 0; c < columns; c++) headRow.append(Object.assign(document.createElement("th"), { textContent: header[c] ?? "" }));
  const blocks: HTMLElement[] = [];
  for (let from = 0; from < shown.length; from += BLOCK_ROWS) {
    const to = Math.min(from + BLOCK_ROWS, shown.length);
    const block = document.createElement("div");
    block.className = "rows";
    block.style.setProperty("--rows", String(to - from));
    block.innerHTML = `<table>${colgroup}<tbody>${rowsHtml(shown, from, to, columns)}</tbody></table>`;
    blocks.push(block);
  }

  const notes = [`${shown.length.toLocaleString("en-US")} row${shown.length === 1 ? "" : "s"}`, formatBytes(file.total)];
  if (truncated || body.length > shown.length) notes.push(`showing the first ${PREVIEW_LIMITS.tableRows.toLocaleString("en-US")} rows; switch to Raw for the rest`);
  else if (file.total > file.data.length) notes.push("file cut at 2 MB; switch to Raw");
  const scroller = document.createElement("div");
  scroller.className = "scroller table-wrap";
  scroller.append(head, ...blocks);
  const footer = document.createElement("div");
  footer.className = "footer";
  footer.textContent = notes.join(" · ");
  app.replaceChildren(scroller, footer);

  // Widths in the fonts the cells really use, then the same on every table's columns.
  const measureIn = (cell: Element | undefined) => {
    const context = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    if (cell) context.font = getComputedStyle(cell).font;
    return (value: string): number => context.measureText(value).width;
  };
  const measure = measureIn(scroller.querySelector("td:not(.n)") ?? headRow.cells[0]);
  const widths = [Math.ceil(measure(String(shown.length))) + CELL_EDGES, ...columnWidths(header, shown, columns, measure, measureIn(headRow.cells[1]))];
  for (const group of scroller.querySelectorAll("colgroup")) {
    for (const [index, col] of [...group.children].entries()) (col as HTMLElement).style.width = `${widths[index] ?? 0}px`;
  }
  scroller.style.setProperty("--width", `${widths.reduce((sum, width) => sum + width, 0)}px`);
  // Rows are one line high, as tall as the header's: off-screen blocks take that guess.
  scroller.style.setProperty("--row", `${headRow.getBoundingClientRect().height}px`);
}
