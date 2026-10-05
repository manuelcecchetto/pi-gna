#!/usr/bin/env node
// Dev tool: end-to-end check of file previews through the real app. Run after `pnpm build`:
//   node scripts/verify-file-preview.mjs
// Generates small fixtures in a temp dir, starts a throwaway app instance (fake pi, which hands its bridge token to this
// script) and opens each file through the browser_open bridge the way the agent does. Checks the tab state, load, a
// non-blank screenshot and kind-specific DOM facts (Office kinds: what the canvas painted and the hidden text layer);
// reopening an open file (shown, not reloaded) and a Markdown link into a docx; then confinement (a web tab and guessed
// tokens cannot reach local files, traversal and symlinks 404, a closed tab's token dies), live reload and chat file
// links. Prints a pass/fail table; exit code 1 on any failure. The chat answer also embeds an image (`![alt](path)`),
// which must load and open the lightbox. Not covered: mp4 (no encoder here; video shares the audio
// path) and the eyeball pass (themes, split/full pane, pop-out window) in docs/FILE_PREVIEW.md.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "pigna-preview-")));
const port = 9488;
const inspect = 9489;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rows = [];
const check = (name, ok, detail = "") => {
  rows.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
};
const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
};

// Fixtures ---------------------------------------------------------------------------------------------------------
const files = join(work, "project");
const outside = join(work, "outside");
mkdirSync(join(files, "sub"), { recursive: true });
mkdirSync(outside);

function crc32(buffer) {
  let c;
  let crc = ~0;
  for (const byte of buffer) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** Three pages: "Preview PDF", "Page two", "Page three". */
function pdf() {
  const texts = ["Preview PDF", "Page two", "Page three"];
  const stream = (text) => {
    const body = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  };
  // 1 catalog, 2 pages, 3 font, then a page and its content per text.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...texts.flatMap((text, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`, stream(text)]),
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
async function docx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello from a docx</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list) => `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const types = (overrides) => `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join("")}</Types>`;
async function xlsx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", types([["/xl/workbook.xml", "spreadsheetml.sheet.main+xml"], ["/xl/worksheets/sheet1.xml", "spreadsheetml.worksheet+xml"], ["/xl/worksheets/sheet2.xml", "spreadsheetml.worksheet+xml"]]));
  zip.file("_rels/.rels", rels([["rId1", "officeDocument", "xl/workbook.xml"]]));
  zip.file("xl/workbook.xml", `${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"]]));
  const cell = (r, v) => (typeof v === "number" ? `<c r="${r}"><v>${v}</v></c>` : `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`);
  zip.file("xl/worksheets/sheet1.xml", `${X}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell("A1", "Hello from a sheet")}${cell("B1", 42)}</row><row r="2">${cell("A2", "second row")}${cell("B2", 7)}</row></sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `${X}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell("A1", "Other sheet")}</row></sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
async function pptx() {
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const ns = `xmlns:a="${A}" xmlns:r="${REL}" xmlns:p="${P}"`;
  const group = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", types([["/ppt/presentation.xml", "presentationml.presentation.main+xml"], ["/ppt/slides/slide1.xml", "presentationml.slide+xml"], ["/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout+xml"], ["/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster+xml"], ["/ppt/theme/theme1.xml", "theme+xml"]]));
  zip.file("_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]]));
  zip.file("ppt/presentation.xml", `${X}<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "theme", "theme/theme1.xml"]]));
  const colors = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const fill = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`;
  zip.file("ppt/theme/theme1.xml", `${X}<a:theme xmlns:a="${A}" name="T"><a:themeElements><a:clrScheme name="C">${colors.map((c, i) => `<a:${c}><a:srgbClr val="${i % 2 ? "FFFFFF" : "1F3864"}"/></a:${c}>`).join("")}</a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="F"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${`<a:ln w="9525">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  zip.file("ppt/slideMasters/slideMaster1.xml", `${X}<p:sldMaster ${ns}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]));
  zip.file("ppt/slideLayouts/slideLayout1.xml", `${X}<p:sldLayout ${ns}><p:cSld><p:spTree>${group}</p:spTree></p:cSld></p:sldLayout>`);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]));
  zip.file("ppt/slides/slide1.xml", `${X}<p:sld ${ns}><p:cSld><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2A7F62"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Hello from a deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]));
  return zip.generateAsync({ type: "nodebuffer" });
}
function wav() {
  const samples = 800;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(16000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples * 2, 40);
  return out;
}

writeFileSync(join(files, "doc.pdf"), pdf());
writeFileSync(join(files, "pic.png"), png(40, 30, [200, 40, 40]));
writeFileSync(join(files, "vector.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><script>window.__pwned = 1</script><rect width="64" height="48" fill="#2a7"/></svg>`);
writeFileSync(join(files, "doc.md"), `# Hello preview\n\nSome **bold** text and a relative image:\n\n![pic](pic.png)\n\n<script>window.__pwned = 1</script>\n<img src="x" onerror="window.__pwned = 1">\n`);
writeFileSync(join(files, "page.html"), `<!doctype html><link rel=stylesheet href="sub/s.css"><body><h1 id=h>Page</h1><img id=i src="pic.png"><script src="sub/s.js"></script>`);
writeFileSync(join(files, "sub", "s.css"), "body { color: rgb(1, 2, 3); }");
writeFileSync(join(files, "sub", "s.js"), `document.body.dataset.ran = "yes";`);
writeFileSync(join(files, "doc.docx"), await docx());
writeFileSync(join(files, "deck.pptx"), await pptx());
writeFileSync(join(files, "sheet.xlsx"), await xlsx());
writeFileSync(join(files, "index.md"), "# Index\n\n- [the document](doc.docx)\n");
writeFileSync(join(files, "big.txt"), Array.from({ length: 60_000 }, (_, i) => `line ${i} of a big file`).join("\n"));
writeFileSync(join(files, "data.json"), JSON.stringify({ name: "pi-gna", nested: { list: [1, 2, 3] } }));
writeFileSync(join(files, "data.csv"), "a,b,c\n1,2,3\n4,5,6\n");
writeFileSync(join(files, "code.ts"), `export const answer: number = 42;\n`);
writeFileSync(join(files, "tone.wav"), wav());
writeFileSync(join(files, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7, 0, 0]));
writeFileSync(join(files, "linked.md"), "# Linked from chat\n");
writeFileSync(join(files, ".env"), "SECRET=1\n");
writeFileSync(join(outside, "secret.txt"), "top secret\n");
symlinkSync(join(outside, "secret.txt"), join(files, "escape.txt"));
// The chat runs in the repo root, not `files`: chat targets are absolute (a relative one would rightly be "not found").
writeFileSync(join(work, "chat.md"), `Previewed [the linked file](${join(files, "linked.md")}), [data](${join(files, "data.json")}:2) and [the document](${join(files, "doc.docx")}).\n\n![a picture](${join(files, "pic.png")}) ![gone](missing.png)\n`);

// A web page to attack the previews from.
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>attacker</title><body>attacker page</body>");
});
await new Promise((open) => server.listen(0, "127.0.0.1", open));
const base = `http://127.0.0.1:${server.address().port}`;

// The app, with a pi stand-in that leaves its bridge address and token behind.
const pi = join(work, "pi.mjs");
writeFileSync(pi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(work, "env.json"))}, JSON.stringify({ url: process.env.PIGNA_BRIDGE, token: process.env.PIGNA_TOKEN }));\nawait import(${JSON.stringify(join(root, "scripts", "fake-pi.mjs"))});\n`);
chmodSync(pi, 0o755);
const app = spawn("node", [join(root, "bin", "pi-gna.mjs"), `--remote-debugging-port=${port}`, `--inspect=${inspect}`], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, PIGNA_USER_DATA: join(work, "profile"), PIGNA_BACKGROUND: "1", PIGNA_CWD: files, PIGNA_PI_BIN: pi, FAKE_TEXT_FILE: join(work, "chat.md"), FAKE_CHUNK: "400", FAKE_DELAY: "20" },
});

let bridge;
async function call(body) {
  const response = await fetch(`${bridge.url}/browser`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}
const evaluate = async (tab, expression) => (await call({ action: "evaluate", expression, tab })).text;
const open = (path, extra = {}) => call({ action: "open", url: path, cwd: files, ...extra });

// CDP over a websocket target; `main` is Node's inspector, `appWindow` the app's own page.
class Cdp {
  seq = 0;
  waiting = new Map();
  constructor(ws) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.waiting.get(message.id)?.(message);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((done) => (ws.onopen = done));
    return new Cdp(ws);
  }
  async send(method, params = {}) {
    const id = ++this.seq;
    const answer = new Promise((done) => this.waiting.set(id, done));
    this.ws.send(JSON.stringify({ id, method, params }));
    const message = await answer;
    if (message.error) throw new Error(message.error.message);
    return message.result;
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
    return result.result.value;
  }
}
let mainCdp;
let windowCdp;
const main = async (expression) => {
  mainCdp ??= await Cdp.connect((await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json())[0].webSocketDebuggerUrl);
  return mainCdp.eval(expression);
};
const appWindow = async (expression) => {
  windowCdp ??= await Cdp.connect((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith("app://")).webSocketDebuggerUrl);
  return windowCdp.eval(expression);
};
const state = () => appWindow("studio.browser.state()");
const tabOf = async (id) => (await state()).tabs.find((t) => t.id === id);
/** The preview URL's token, read from the tab (clients only ever show the path). */
const tokenOf = async (id) => /^pigna-file:\/\/([0-9a-f]+)\//.exec((await tabOf(id)).url)?.[1];
/** Fetch through the browser session, so the protocol handler answers (what a tab's own request would get). */
const sessionStatus = (url) =>
  main(`process.mainModule.require("electron").session.fromPartition("persist:pigna-browser").fetch(${JSON.stringify(url)}).then((r) => r.status, (e) => "error " + e.message)`);
/** Distinct colors among sampled pixels of a JPEG screenshot: a blank (single color) page has one. */
const colors = (image) =>
  main(`(() => { const { nativeImage } = process.mainModule.require("electron"); const img = nativeImage.createFromBuffer(Buffer.from(${JSON.stringify(image)}, "base64")); const b = img.toBitmap(); const seen = new Set(); for (let i = 0; i < b.length; i += 4 * 97) seen.add((b[i] >> 3) + "," + (b[i + 1] >> 3) + "," + (b[i + 2] >> 3)); return seen.size; })()`);

// Office views paint on canvas: what they painted, the footer, and the hidden text layer the agent's snapshot reads.
const OFFICE_DOM = `JSON.stringify({ pages: document.querySelectorAll(".canvas-page").length, status: document.querySelector(".office-status")?.textContent ?? "", slides: document.querySelectorAll(".pptx-slide.painted").length, sheet: performance.getEntriesByName("preview:first-page").length > 0 && !!document.querySelector(".xlsx-canvas"), tabs: document.querySelectorAll(".xlsx-tabs button").length, text: document.querySelector(".sr-only")?.textContent ?? "" })`;
/** The page's load time: unchanged means the tab was shown again, not reloaded. */
const LOADED = "String(performance.timeOrigin)";

// One row per kind: file, expected kind, DOM facts through evaluate (evaluated in the preview tab).
const kinds = [
  { file: "doc.pdf", kind: "pdf", dom: `JSON.stringify({ type: document.contentType, plugin: !!document.querySelector("embed, object"), pages: document.querySelectorAll(".pdfViewer .page").length, text: document.querySelector(".textLayer")?.textContent ?? "", count: document.querySelector(".pdf-bar")?.textContent ?? "" })`, ok: (v) => { const r = JSON.parse(v); return r.type === "text/html" && !r.plugin && r.pages === 3 && /Preview PDF/.test(r.text) && /\/ 3/.test(r.count); }, what: "pdf.js pages + text layer under our toolbar, no Chromium plugin" },
  { file: "pic.png", kind: "image", dom: `(() => { const i = document.querySelector("img"); return i && i.complete ? i.naturalWidth + "x" + i.naturalHeight : "" })()`, ok: (v) => v === "40x30", what: "image natural size 40x30" },
  { file: "vector.svg", kind: "image", dom: `(() => { const i = document.querySelector("img"); return i && i.complete ? i.naturalWidth + ":" + (window.__pwned ?? "inert") : "" })()`, ok: (v) => /^64:inert$/.test(v), what: "svg shown as <img>, script inert" },
  { file: "doc.md", kind: "markdown", dom: `JSON.stringify({ h: document.querySelector("h1")?.textContent, bold: !!document.querySelector("strong"), img: document.querySelector("img[src*='pic.png']")?.naturalWidth ?? 0, pwned: window.__pwned ?? null })`, ok: (v) => { const r = JSON.parse(v); return /Hello preview/.test(r.h) && r.bold && r.img === 40 && r.pwned === null; }, what: "heading + bold + relative image rendered, script inert" },
  { file: "page.html", kind: "html", dom: `JSON.stringify({ color: getComputedStyle(document.body).color, ran: document.body.dataset.ran, img: document.getElementById("i")?.naturalWidth })`, ok: (v) => { const r = JSON.parse(v); return r.color === "rgb(1, 2, 3)" && r.ran === "yes" && r.img === 40; }, what: "relative css, js and image applied" },
  { file: "doc.docx", kind: "docx", dom: OFFICE_DOM, ok: (v) => { const r = JSON.parse(v); return r.pages === 1 && /^1 page/.test(r.status) && r.text.includes("Hello from a docx"); }, what: "docx canvas page, page count, text layer" },
  { file: "deck.pptx", kind: "pptx", dom: OFFICE_DOM, ok: (v) => { const r = JSON.parse(v); return r.slides === 1 && r.text.includes("Hello from a deck"); }, what: "pptx slide painted, text layer" },
  { file: "sheet.xlsx", kind: "xlsx", dom: OFFICE_DOM, ok: (v) => { const r = JSON.parse(v); return r.sheet && r.tabs === 2 && r.text.includes("Hello from a sheet"); }, what: "xlsx sheet painted, 2 tabs, text layer" },
  { file: "big.txt", kind: "text", dom: `document.body.innerText.length`, ok: (v) => Number(v) > 1000, what: "large text rendered (capped)" },
  { file: "code.ts", kind: "code", dom: `document.body.innerText.includes("answer")`, ok: (v) => v === "true", what: "code shown" },
  { file: "data.json", kind: "json", dom: `document.body.innerText.includes("pi-gna") && document.body.innerText.includes("nested")`, ok: (v) => v === "true", what: "json keys shown" },
  { file: "data.csv", kind: "table", dom: `document.querySelectorAll("table tr").length`, ok: (v) => Number(v) >= 3, what: "csv table has 3 rows" },
  { file: "tone.wav", kind: "audio", dom: `!!document.querySelector("audio")`, ok: (v) => v === "true", what: "audio element" },
  { file: "blob.bin", kind: "other", dom: `document.body.innerText.includes("blob.bin")`, ok: (v) => v === "true", what: "info card names the file" },
];

try {
  for (let i = 0; i < 400 && !bridge; i++) {
    await sleep(100);
    try {
      bridge = JSON.parse(readFileSync(join(work, "env.json"), "utf8"));
    } catch {}
  }
  if (!bridge) throw new Error("the app never started a session (no bridge token)");
  await sleep(1500);

  // 1. every kind, opened the way the agent does
  const tabs = {};
  for (const k of kinds) {
    try {
      const result = await open(join(files, k.file), { newTab: true });
      tabs[k.file] = result.tab;
      const tab = await until(`${k.file} to load`, async () => {
        const t = await tabOf(result.tab);
        return t && !t.loading && t.preview ? t : undefined;
      });
      check(`${k.file}: tab has preview kind ${k.kind}`, tab.preview.kind === k.kind && tab.preview.path === join(files, k.file) && tab.url.startsWith("pigna-file://"), `${tab.preview.kind} ${tab.url.slice(0, 40)}`);
      check(`${k.file}: bridge answers with the real path`, result.url === join(files, k.file), result.url);
      let value;
      await until(k.what, async () => ((value = await evaluate(result.tab, k.dom)), k.ok(value)), 15_000).catch(() => undefined);
      check(`${k.file}: ${k.what}`, k.ok(value), String(value).slice(0, 100));
      await sleep(400);
      const shot = await call({ action: "screenshot", tab: result.tab });
      const distinct = await colors(shot.image);
      check(`${k.file}: screenshot is not blank`, distinct > 3, `${distinct} colors`);
    } catch (error) {
      check(`${k.file}`, false, error.message);
    }
  }

  // 1a. one header: a preview gets no app toolbar row (the viewer's bar is the header); two-mode kinds show the
  // Rendered/Raw switch in the tab strip instead
  try {
    const chrome = async (id) => {
      await appWindow(`studio.browser.activate(${JSON.stringify(id)})`);
      await sleep(300);
      return appWindow(`JSON.stringify({ row: !!document.querySelector('button[title="Reveal in Finder"]'), modes: [...document.querySelectorAll(".titlebar button")].map((b) => b.textContent.trim().toLowerCase()).filter((t) => t === "rendered" || t === "raw") })`).then(JSON.parse);
    };
    const pdfChrome = await chrome(tabs["doc.pdf"]);
    const mdChrome = await chrome(tabs["doc.md"]);
    check("one header: no app toolbar row on a preview", !pdfChrome.row && !mdChrome.row, JSON.stringify({ pdfChrome, mdChrome }));
    check("one header: mode switch in the tab strip only for two-mode kinds", pdfChrome.modes.length === 0 && mdChrome.modes.join() === "rendered,raw");
  } catch (error) {
    check("one header", false, error.message);
  }

  // 1b. our PDF controls drive pdf.js: Cmd+F opens the find card, which moves to the match's page; zoom leaves Fit; the
  // page box jumps; Escape hides find again. The page script always settles (a throw would hang the bridge call).
  try {
    const pdfTab = tabs["doc.pdf"];
    const facts = JSON.parse(
      await evaluate(
        pdfTab,
        `new Promise((done) => (async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const key = (init) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
          const card = document.querySelector(".pdf-find");
          const page = document.querySelector(".pdf-page");
          const query = card.querySelector("input");
          const hiddenAtStart = card.hidden;
          key({ key: "f", metaKey: true });
          const shown = !card.hidden && document.activeElement === query && getComputedStyle(card).position === "absolute";
          query.value = "page three";
          query.dispatchEvent(new Event("input"));
          for (let i = 0; i < 40 && page.value !== "3"; i++) await wait(100);
          const found = { page: page.value, matches: card.querySelector(".pdf-matches").textContent, highlight: !!document.querySelector(".textLayer .highlight") };
          query.value = "no such words";
          query.dispatchEvent(new Event("input"));
          for (let i = 0; i < 20 && !query.classList.contains("missing"); i++) await wait(100);
          const missing = card.querySelector(".pdf-matches").textContent;
          query.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          const closed = card.hidden;
          const [, level, inn] = document.querySelectorAll(".pdf-zoom button");
          const fit = level.textContent;
          inn.click();
          await wait(200);
          const zoomed = level.textContent;
          page.value = "1";
          page.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
          await wait(300);
          done(JSON.stringify({ hiddenAtStart, shown, found, missing, closed, fit, zoomed, back: page.value, prevDisabled: document.querySelector(".pdf-nav button").disabled }));
        })().catch((error) => done(JSON.stringify({ error: String(error) }))))`,
      ),
    );
    if (facts.error) throw new Error(facts.error);
    check("pdf: find is hidden until Cmd+F opens it as a floating card", facts.hiddenAtStart === true && facts.shown === true, `${facts.hiddenAtStart} ${facts.shown}`);
    check("pdf: find jumps to the matching page and counts it", facts.found.page === "3" && facts.found.matches === "1 of 1" && facts.found.highlight, JSON.stringify(facts.found));
    check("pdf: find reports no matches", facts.missing === "No matches", facts.missing);
    check("pdf: Escape closes find", facts.closed === true);
    check("pdf: zoom in leaves Fit for a percentage", facts.fit === "Fit" && /^\d+%$/.test(facts.zoomed), `${facts.fit} -> ${facts.zoomed}`);
    check("pdf: page box jumps back to page 1", facts.back === "1" && facts.prevDisabled === true, `${facts.back} prev disabled ${facts.prevDisabled}`);
    const consoleLog = await call({ action: "console", tab: pdfTab });
    check("pdf: no CSP violations or load errors", !/Content Security Policy|Refused to|Failed to (load|fetch)|wasm/i.test(consoleLog.text), consoleLog.text.slice(0, 160));
  } catch (error) {
    check("pdf controls", false, error.message);
  }
  // 1c. opening an open file again shows its tab as it is (a long document keeps its layout and scroll position)
  const docxTab = tabs["doc.docx"];
  const loadedAt = await evaluate(docxTab, LOADED);
  const again = await open(join(files, "doc.docx"));
  check("reopen: an open docx comes back in its tab", again.tab === docxTab, again.tab);
  check("reopen: the docx page is not reloaded", (await evaluate(docxTab, LOADED)) === loadedAt);

  // 1d. a link in a rendered Markdown preview opens the file in the same tab
  const index = (await open(join(files, "index.md"), { newTab: true })).tab;
  await until("the index link", async () => (await evaluate(index, `!!document.querySelector('a[href$="doc.docx"]')`)) === "true");
  await evaluate(index, `document.querySelector('a[href$="doc.docx"]').click(); 1`);
  const followed = await until("the linked docx", async () => {
    const t = await tabOf(index);
    return t?.preview?.kind === "docx" && JSON.parse(await evaluate(index, OFFICE_DOM)).pages > 0 ? t : undefined;
  }, 15_000).catch(() => undefined);
  check("markdown preview: a link to a docx follows in the tab", !!followed, followed ? followed.preview.name : "no docx");
  tabs["index.md"] = index;

  // 2. confinement from a web tab
  await call({ action: "open", url: base, newTab: true });
  const web = { tab: (await state()).activeId };
  await sleep(800);
  const token = await tokenOf(tabs["doc.md"]);
  const guess = "0".repeat(32);
  const attack = `new Promise(async (done) => {
    const out = {};
    for (const [name, t] of [["real", ${JSON.stringify(token)}], ["guess", ${JSON.stringify(guess)}]]) {
      const url = "pigna-file://" + t + "/doc.md";
      out[name + "Fetch"] = await fetch(url).then(() => "read", () => "blocked");
      const frame = document.createElement("iframe");
      frame.src = url;
      document.body.append(frame);
      await new Promise((r) => { frame.onload = r; setTimeout(r, 1500); });
      out[name + "Frame"] = (() => { try { return frame.contentDocument ? "read" : "blocked"; } catch { return "blocked"; } })();
    }
    const before = location.href;
    window.open("pigna-file://" + ${JSON.stringify(token)} + "/doc.md");
    location.href = "pigna-file://" + ${JSON.stringify(token)} + "/doc.md";
    await new Promise((r) => setTimeout(r, 800));
    out.navigated = location.href !== before;
    done(JSON.stringify(out));
  })`;
  const tabCount = (await state()).tabs.length;
  const verdict = JSON.parse(await evaluate(web.tab, attack));
  check("web tab: fetch of a preview URL fails", verdict.realFetch === "blocked" && verdict.guessFetch === "blocked", JSON.stringify(verdict));
  check("web tab: iframe of a preview URL is unreadable", verdict.realFrame === "blocked" && verdict.guessFrame === "blocked");
  check("web tab: navigation to a preview URL is cancelled", verdict.navigated === false && (await tabOf(web.tab)).url.startsWith("http"), (await tabOf(web.tab)).url.slice(0, 40));
  check("web tab: window.open of a preview URL opens no tab", (await state()).tabs.length === tabCount);

  // 3. containment in the handler (what any request on a token gets)
  const at = (rel, t = token) => sessionStatus(`pigna-file://${t}/${rel}`);
  check("handler: served file is 200", (await at("doc.md")) === 200);
  check("handler: guessed token is 404", (await at("doc.md", guess)) === 404);
  check("handler: ../ traversal is not served", (await at("../outside/secret.txt")) === 404);
  check("handler: encoded traversal is 404", (await at("%2e%2e/outside/secret.txt")) === 404);
  check("handler: symlink out of the root is 404", (await at("escape.txt")) === 404);
  check("handler: dotfile is 404", (await at(".env")) === 404);
  check("handler: directory is 404", (await at("sub")) === 404);
  const doomed = (await open(join(files, "linked.md"), { newTab: true })).tab;
  const doomedUrl = (await tabOf(doomed)).url;
  check("closing a preview: URL served while open", (await sessionStatus(doomedUrl)) === 200);

  // 4. live reload
  const mdTab = tabs["doc.md"];
  writeFileSync(join(files, "doc.md"), "# Reloaded heading\n");
  const reloaded = await until("live reload", async () => /Reloaded heading/.test(await evaluate(mdTab, `document.querySelector("h1")?.textContent ?? ""`)), 8000).catch(() => false);
  check("live reload: saved markdown shows its new content", reloaded === true);

  // 5. token dies with the last tab of its root (the project token is shared, so close every project tab)
  for (const id of [...Object.values(tabs), doomed]) await appWindow(`studio.browser.closeTab(${JSON.stringify(id)})`);
  await sleep(500);
  check("closing the preview tabs: their token is 404", (await at("doc.md")) === 404 && (await sessionStatus(doomedUrl)) === 404);

  // 6. a chat file link, clicked in the app window
  const key = (type, extra) => windowCdp.send("Input.dispatchKeyEvent", { type, ...extra });
  await until("the composer", () => appWindow(`!!document.querySelector("textarea")`), 15_000);
  await appWindow(`document.querySelector("textarea").focus()`);
  await windowCdp.send("Input.insertText", { text: "show me the files" });
  await key("keyDown", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await key("keyUp", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const link = await until("a file link in the answer", () => appWindow(`(() => { const el = document.querySelector("[data-file]"); return el ? el.className + "|" + el.textContent : ""; })()`), 20_000).catch(() => "");
  check("chat: a file link renders as a link chip", /file-link/.test(link) && !/file-missing/.test(link) && /linked file/.test(link), link);
  if (link) {
    await appWindow(`document.querySelector("[data-file$='linked.md']")?.click()`);
    const opened = await until("the preview tab", async () => (await state()).tabs.find((t) => t.preview?.path === join(files, "linked.md")), 8000).catch(() => undefined);
    check("chat: clicking the link opens a preview tab", !!opened, opened ? opened.preview.name : "no tab");
    await appWindow(`document.querySelector("[data-file$='doc.docx']")?.click()`);
    const docx = await until("the docx preview", async () => {
      const t = (await state()).tabs.find((t) => t.preview?.path === join(files, "doc.docx"));
      return t && JSON.parse(await evaluate(t.id, OFFICE_DOM)).pages > 0 ? t : undefined;
    }, 15_000).catch(() => undefined);
    check("chat: a docx link opens a painted canvas preview", !!docx, docx ? docx.preview.name : "no docx");
  }
  const picture = await until("the embedded image", () => appWindow(`(() => { const i = document.querySelector(".chat-image img"); return i && i.complete && i.naturalWidth ? i.naturalWidth + "x" + i.naturalHeight + "|" + i.alt : ""; })()`), 8000).catch(() => "");
  check("chat: an embedded image renders inline", picture === "40x30|a picture", picture);
  const missing = await appWindow(`(() => { const el = [...document.querySelectorAll(".chat-image")].find((e) => e.textContent === "gone"); return el ? el.className + "|" + el.title : ""; })()`);
  check("chat: a missing embedded image is muted text", /file-missing/.test(missing) && /missing\.png/.test(missing), missing);
  if (picture) {
    const before = (await state()).tabs.length;
    await appWindow(`document.querySelector(".chat-image img").click()`);
    const zoomed = await until("the lightbox", () => appWindow(`(() => { const i = document.querySelector("button.fixed img"); return i?.src.startsWith("data:image/png") ? "open" : ""; })()`), 4000).catch(() => "");
    check("chat: clicking the image opens the lightbox, not a preview", zoomed === "open" && (await state()).tabs.length === before, `${zoomed} tabs ${before}->${(await state()).tabs.length}`);
  }
} catch (error) {
  check("run", false, error instanceof Error ? error.message : String(error));
} finally {
  mainCdp?.ws.close();
  windowCdp?.ws.close();
  app.kill("SIGTERM");
  await new Promise((done) => (app.exitCode === null ? app.once("exit", done) : done()));
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${rows.length} checks failed` : `\nall ${rows.length} checks passed`);
process.exit(failed ? 1 : 0);
