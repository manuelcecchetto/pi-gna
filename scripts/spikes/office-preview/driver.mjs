// Electron driver: serves dist/ + files/ over a pigna-file-like privileged scheme (same privileges, same headers as
// src/main/browser/preview-protocol.ts serveViewer), loads one harness page per run, records bytes served, timings,
// renderer peak memory, AX text, console/CSP errors and a screenshot.
// usage: electron driver.mjs <page> <file> <csp: strict|relaxed> <runs> <outJson>
import { app, BrowserWindow, protocol, session } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const [page, file, cspMode = "relaxed", runsArg = "3", out = "res/out.json"] = process.argv.slice(2);
const ROOT = import.meta.dirname; // files/, dist/ (dist/codex and dist/ql are symlinks, see README), res/ and shots/ live here
const STRICT = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "font-src 'self' data:", "connect-src 'self'", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
];
const csp = (cspMode === "strict" ? STRICT : STRICT.map((d) => d === "script-src 'self'" ? "script-src 'self' 'wasm-unsafe-eval'" : d).concat("worker-src 'self'")).join("; ");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".ttf": "font/ttf", ".json": "application/json" };

protocol.registerSchemesAsPrivileged([{ scheme: "spike", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.commandLine.appendSwitch("enable-precise-memory-info");

let served = [];
async function handle(req) {
  const u = new URL(req.url);
  const rel = normalize(decodeURIComponent(u.pathname)).replace(/^\/+/, "");
  const path = rel.startsWith("files/") ? join(ROOT, rel) : join(ROOT, "dist", rel);
  try {
    const body = await readFile(path);
    served.push({ path: rel, bytes: body.length });
    return new Response(body, { headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": csp } });
  } catch { return new Response("nf", { status: 404 }); }
}

async function run(ses, i) {
  served = [];
  const win = new BrowserWindow({ width: 1040, height: 1400, show: false, useContentSize: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  const wc = win.webContents;
  const consoleMsgs = [];
  wc.on("console-message", (e) => { if (e.level === "warning" || e.level === "error") consoleMsgs.push(String(e.message).slice(0, 300)); });
  const t0 = Date.now();
  let peakKB = 0, peakGpuKB = 0, baseGpuKB = null;
  const sample = () => {
    const pid = wc.getOSProcessId();
    for (const m of app.getAppMetrics()) {
      if (m.pid === pid) peakKB = Math.max(peakKB, m.memory.workingSetSize);
      if (m.type === "GPU") { baseGpuKB ??= m.memory.workingSetSize; peakGpuKB = Math.max(peakGpuKB, m.memory.workingSetSize); }
    }
  };
  const timer = setInterval(sample, 25);
  if (page === "ql") {
    await wc.loadURL(`spike://h/ql/${encodeURIComponent(file)}.qlpreview/Preview.html`).catch((e) => consoleMsgs.push("load " + e.message));
    await wc.executeJavaScript(`new Promise((r) => requestAnimationFrame(() => r(window.__result = { ok: true, marks: { firstPage: Math.round(performance.now()), settled: Math.round(performance.now()) }, pages: document.querySelectorAll("body > div").length })))`);
  } else await wc.loadURL(`spike://h/${page}.html?f=${encodeURIComponent(file)}${process.env.Q ? "&" + process.env.Q : ""}`).catch((e) => consoleMsgs.push("load " + e.message));
  let result;
  for (let k = 0; k < 1800; k++) {
    result = await wc.executeJavaScript("window.__result ?? null").catch(() => null);
    if (result) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const wall = Date.now() - t0;
  // Keep sampling a moment after the first page for the settle peak.
  await new Promise((r) => setTimeout(r, 800));
  clearInterval(timer); sample();
  const errors = await wc.executeJavaScript("window.__errors ?? []").catch(() => []);
  const innerTextLen = await wc.executeJavaScript("document.body.innerText.length").catch(() => -1);
  const jsHeapMB = await wc.executeJavaScript("Math.round(performance.memory.usedJSHeapSize/1048576)").catch(() => -1);
  let axTextChars = -1;
  try {
    wc.debugger.attach("1.3");
    const { nodes } = await wc.debugger.sendCommand("Accessibility.getFullAXTree");
    axTextChars = nodes.filter((n) => !n.ignored && (n.role?.value === "StaticText" || n.role?.value === "InlineTextBox"))
      .filter((n) => n.role?.value === "StaticText").reduce((a, n) => a + String(n.name?.value ?? "").length, 0);
    wc.debugger.detach();
  } catch (e) { consoleMsgs.push("ax " + e.message); }
  let shot = null;
  if (i === 0) {
    await mkdir(join(ROOT, "shots"), { recursive: true });
    const img = await wc.capturePage();
    shot = join(ROOT, "shots", `${page}-${file}-${cspMode}${process.env.Q ? "-" + process.env.Q.replace(/[&=]/g, "") : ""}.png`);
    await writeFile(shot, img.toPNG());
  }
  const byKind = {};
  for (const s of served) { const k = s.path.startsWith("files/") ? "file" : extname(s.path).slice(1); byKind[k] = (byKind[k] ?? 0) + s.bytes; }
  const wasm = served.filter((s) => s.path.endsWith(".wasm")).map((s) => `${s.path.replace(/^.*\//, "").replace(/-[\w-]{8}\.wasm$/, "")} ${(s.bytes / 1e6).toFixed(1)}MB`);
  const fonts = served.filter((s) => s.path.endsWith(".ttf")).length;
  win.destroy();
  return { run: i, wall, result, bytesTotal: served.reduce((a, s) => a + s.bytes, 0), byKind, wasm, fonts, peakRendererMB: Math.round(peakKB / 1024),
    gpuDeltaMB: baseGpuKB == null ? null : Math.round((peakGpuKB - baseGpuKB) / 1024), jsHeapMB, innerTextLen, axTextChars, errors, console: consoleMsgs.slice(0, 8), shot };
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(`spike-${Date.now()}`); // in-memory partition: nothing persisted between processes
  ses.protocol.handle("spike", handle);
  const runs = [];
  for (let i = 0; i < Number(runsArg); i++) runs.push(await run(ses, i));
  await writeFile(out, JSON.stringify({ page, file, cspMode, runs }, null, 1));
  app.quit();
});
app.on("window-all-closed", () => {});
