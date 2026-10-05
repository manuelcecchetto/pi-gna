// Cheap TS prototype: jszip + DOMParser -> HTML table of the first sheet (values only: shared strings, inline strings, cached formula results).
import JSZip from "jszip";
import { done, fail, loadBytes, mark } from "./common";
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
function col(ref: string) { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function colName(i: number) { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }
(async () => {
  mark("script");
  const zip = await JSZip.loadAsync(await loadBytes());
  const text = async (p: string) => (await zip.file(p)?.async("string")) ?? "";
  const wb = xml(await text("xl/workbook.xml"));
  const rels = xml(await text("xl/_rels/workbook.xml.rels"));
  const sheets = [...wb.getElementsByTagNameNS(NS, "sheet")].map((s) => {
    const rid = s.getAttributeNS(RNS, "id");
    const target = [...rels.getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === rid)!.getAttribute("Target")!;
    return { name: s.getAttribute("name")!, path: target.startsWith("/") ? target.slice(1) : "xl/" + target };
  });
  const sst = [...xml(await text("xl/sharedStrings.xml")).getElementsByTagNameNS(NS, "si")].map((si) => [...si.getElementsByTagNameNS(NS, "t")].map((t) => t.textContent).join(""));
  const sheet = xml(await text(sheets[0].path));
  const rows: string[][] = []; let maxC = 0;
  for (const r of sheet.getElementsByTagNameNS(NS, "row")) {
    const ri = Number(r.getAttribute("r")) - 1; const row: string[] = (rows[ri] = []);
    for (const c of r.getElementsByTagNameNS(NS, "c")) {
      const ci = col(c.getAttribute("r")!); const t = c.getAttribute("t");
      const v = c.getElementsByTagNameNS(NS, "v")[0]?.textContent ?? "";
      row[ci] = t === "s" ? sst[Number(v)] : t === "inlineStr" ? (c.getElementsByTagNameNS(NS, "t")[0]?.textContent ?? "") : v;
      maxC = Math.max(maxC, ci + 1);
    }
  }
  const root = document.getElementById("root")!; root.style.height = "auto";
  const tabs = document.createElement("div"); tabs.className = "tabs";
  for (const s of sheets) { const t = document.createElement("span"); t.textContent = s.name; tabs.append(t); }
  const table = document.createElement("table"); table.className = "x";
  const head = table.insertRow(); head.append(document.createElement("th"));
  for (let c = 0; c < maxC; c++) { const th = document.createElement("th"); th.textContent = colName(c); head.append(th); }
  for (let r = 0; r < Math.min(rows.length, 5000); r++) {
    const tr = table.insertRow(); const th = document.createElement("th"); th.textContent = String(r + 1); tr.append(th);
    for (let c = 0; c < maxC; c++) tr.insertCell().textContent = rows[r]?.[c] ?? "";
  }
  root.append(tabs, table);
  await new Promise(requestAnimationFrame);
  mark("firstPage");
  done({ sheets: sheets.length, rows: rows.length, cols: maxC });
})().catch(fail);
