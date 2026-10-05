// CSV/TSV as a table (first PREVIEW_LIMITS.tableRows rows); raw mode is the text view.
import { PREVIEW_LIMITS } from "../shared/preview";
import { parseCsv } from "./csv";
import { formatBytes } from "./format";
import { app, readBytes, showMessage, type Source } from "./shell";

export async function showTable(source: Source): Promise<void> {
  const file = await readBytes(source.rawUrl, PREVIEW_LIMITS.text);
  if (file.total === 0) return showMessage("This file is empty.");
  const text = new TextDecoder().decode(file.data, { stream: true });
  const delimiter = source.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const { rows, truncated } = parseCsv(text, delimiter, PREVIEW_LIMITS.tableRows + 1);
  const [header = [], ...body] = rows;
  const shown = body.slice(0, PREVIEW_LIMITS.tableRows);
  const columns = Math.max(header.length, ...shown.map((row) => row.length));

  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  head.append(Object.assign(document.createElement("th"), { className: "n" }));
  for (let c = 0; c < columns; c++) head.append(Object.assign(document.createElement("th"), { textContent: header[c] ?? "" }));
  const tbody = table.createTBody();
  shown.forEach((row, index) => {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = String(index + 1);
    tr.cells[0]?.classList.add("n");
    for (let c = 0; c < columns; c++) tr.insertCell().textContent = row[c] ?? "";
  });

  const notes = [`${shown.length.toLocaleString("en-US")} row${shown.length === 1 ? "" : "s"}`, formatBytes(file.total)];
  if (truncated || body.length > shown.length) notes.push(`showing the first ${PREVIEW_LIMITS.tableRows.toLocaleString("en-US")} rows; switch to Raw for the rest`);
  else if (file.total > file.data.length) notes.push("file cut at 2 MB; switch to Raw");
  const scroller = document.createElement("div");
  scroller.className = "scroller table-wrap";
  scroller.append(table);
  const footer = document.createElement("div");
  footer.className = "footer";
  footer.textContent = notes.join(" · ");
  app.replaceChildren(scroller, footer);
}
