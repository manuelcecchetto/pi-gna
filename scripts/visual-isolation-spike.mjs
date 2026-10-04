// Throwaway spike for docs/DESIGN.md "Visuals": measures how an inline-visual iframe is isolated in Electron.
//   node_modules/.bin/electron scripts/visual-isolation-spike.mjs   # prints a JSON report, exits
// Mirrors the real setup: app://pigna page with the renderer CSP, frames from a privileged `pigna-visual` scheme.
import { app, BrowserWindow, nativeTheme, protocol } from "electron";

const PARENT_CSP = (frameSrc) =>
  ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self'",
   "object-src 'none'", "base-uri 'none'", "form-action 'none'", `frame-src ${frameSrc}`, "frame-ancestors 'none'"].join("; ");
const FRAME_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors app://pigna";
const FLAGS = JSON.parse(process.env.FLAGS || '{"standard":true,"secure":true}');

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "pigna-visual", privileges: FLAGS },
]);

const page = (body) => `<!doctype html><meta charset=utf-8><body>${body}`;
const html = (s, csp) => new Response(s, { headers: { "content-type": "text/html", "content-security-policy": csp } });

// Probe run inside the sandboxed frame; reports through postMessage.
const probe = `
const out = {}; const done = (k, v) => (out[k] = v);
const tryit = async (k, f) => { try { done(k, await f()); } catch (e) { done(k, "blocked: " + e.name); } };
(async () => {
  done("kitScriptViaSelf", window.__kit === 1); done("kitCssViaSelf", getComputedStyle(document.body).getPropertyValue("--kit").trim() === "1"); done("origin", location.origin); done("opaque", String(origin));
  done("dark", matchMedia("(prefers-color-scheme: dark)").matches);
  await tryit("fetchSelf", () => fetch(location.href).then((r) => r.status));
  await tryit("fetchRemote", () => fetch("https://example.com/").then((r) => r.status));
  await tryit("xhr", () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", "https://example.com/"); x.onload = () => res(x.status); x.onerror = () => rej({ name: "error" }); x.send(); }));
  await tryit("ws", () => new Promise((res, rej) => { const w = new WebSocket("wss://example.com/"); w.onopen = () => res("open"); w.onerror = () => rej({ name: "error" }); }));
  await tryit("img", () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => rej({ name: "error" }); i.src = "https://example.com/favicon.ico"; }));
  await tryit("cssImport", () => new Promise((res, rej) => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://example.com/x.css"; l.onload = () => res("loaded"); l.onerror = () => rej({ name: "error" }); document.head.append(l); }));
  await tryit("windowOpen", () => String(window.open("https://example.com/")));
  await tryit("topNav", () => { top.location.href = "https://example.com/"; return "no throw"; });
  await tryit("topRead", () => String(top.document.title));
  await tryit("parentStudio", () => String(typeof parent.studio));
  await tryit("localStorage", () => String(localStorage.length));
  await tryit("alert", () => String(alert("x")));
  await tryit("formSubmit", () => { const f = document.createElement("form"); f.action = "https://example.com/"; document.body.append(f); f.submit(); return "no throw"; });
  document.body.insertAdjacentHTML("beforeend", '<div style="height:300px"></div><a id=lnk href="https://example.com/">x</a><a id=lnk2 target=_blank href="https://example.com/">y</a>');
  new ResizeObserver(() => parent.postMessage({ type: "height", h: document.documentElement.scrollHeight }, "*")).observe(document.body);
  parent.postMessage({ type: "probe", out }, "*");
  addEventListener("message", (e) => { if (e.data?.type === "ping") parent.postMessage({ type: "pong", from: e.source === parent }, "*"); if (e.data?.type === "spin") for (;;) {} });
  setInterval(() => parent.postMessage({ type: "heartbeat" }, "*"), 100);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => parent.postMessage({ type: "scheme", dark: e.matches }, "*"));
  if (!location.search.includes("links")) return;
  document.getElementById("lnk2").click();
  await new Promise((r) => setTimeout(r, 400));
  parent.postMessage({ type: "afterBlankLink", alive: true, href: location.href }, "*");
  document.getElementById("lnk").click();
  await new Promise((r) => setTimeout(r, 400));
  parent.postMessage({ type: "afterSelfLink", alive: true, href: location.href }, "*");
})();`;

const parentJs = `
const r = (window.__r = {});
const wait = (ms) => new Promise((x) => setTimeout(x, ms));
const frame = (src, sandbox) => { const f = document.createElement("iframe"); if (sandbox) f.sandbox = sandbox; if (src.startsWith("<")) f.srcdoc = src; else f.src = src; document.body.append(f); return f; };
window.addEventListener("message", (e) => { (window.__allmsgs ||= []).push({ type: e.data?.type, data: e.data }), (window.__msgs ||= []).push({ type: e.data?.type, fromFrame: [...document.querySelectorAll("iframe")].some((f) => f.contentWindow === e.source), origin: e.origin, data: e.data }); });
window.run = async (phase) => {
  if (phase === "a") {
    // srcdoc / data: / blob: inheriting the parent CSP; each sets document.title marker via postMessage if its inline script runs.
    const code = "<script>parent.postMessage({type:'ran'},'*')<\\/script>";
    const res = {};
    for (const [k, mk] of Object.entries({
      srcdoc: () => frame(code, "allow-scripts"),
      srcdocNoSandbox: () => frame(code),
      data: () => frame("data:text/html," + encodeURIComponent(code), "allow-scripts"),
      blob: () => frame(URL.createObjectURL(new Blob([code], { type: "text/html" })), "allow-scripts"),
    })) {
      window.__msgs = []; window.__v = []; const h = (e) => window.__v.push(e.violatedDirective); document.addEventListener("securitypolicyviolation", h); const el = mk(); const loaded = await new Promise((x) => { el.onload = () => x(true); setTimeout(() => x(false), 700); }); await wait(300); document.removeEventListener("securitypolicyviolation", h); el.remove();
      res[k] = (window.__msgs.some((m) => m.type === "ran") ? "inline script RAN" : "inline script blocked") + "; frame loaded=" + loaded + "; violations=" + JSON.stringify(window.__v);
    }
    return res;
  }
  if (phase === "b") {
    window.__msgs = []; const f = frame("pigna-visual://" + (window.__host || "frame") + "/doc" + (window.__links ? "?links" : ""), "allow-scripts"); window.__f = f; await wait(1500);
    return window.__msgs.find((m) => m.type === "probe")?.data.out ?? "no probe (frame did not load/run)";
  }
  if (phase === "d") {
    const f = window.__f; window.__msgs = []; f.contentWindow.postMessage({ type: "ping" }, "*"); await wait(300);
    const pong = window.__msgs.find((m) => m.type === "pong");
    window.__msgs = []; window.postMessage({ type: "spoof" }, "*"); await wait(100);
    const spoof = window.__msgs[0];
    return { heights: (window.__allmsgs || []).filter((m) => m.type === "height").map((m) => m.data.h), pong: pong && { fromFrame: pong.fromFrame, origin: pong.origin, fromParentInFrame: pong.data.from }, spoofFromFrame: spoof?.fromFrame, hb: (window.__msgs.length) };
  }
  if (phase === "e") {
    window.__msgs = []; await wait(400); const before = window.__msgs.filter((m) => m.type === "heartbeat").length;
    window.__f.contentWindow.postMessage({ type: "spin" }, "*"); await wait(200);
    let ticks = 0; const t0 = performance.now(); const iv = setInterval(() => ticks++, 50); let maxGap = 0, last = performance.now();
    const gap = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
    await wait(2500); clearInterval(iv); clearInterval(gap);
    const hb = window.__msgs.filter((m) => m.type === "heartbeat").length - before;
    window.__f.remove(); await wait(300); window.__removed = true;
    return { parentTicksIn2.5s: ticks, expected: 50, parentMaxTimerGapMs: Math.round(maxGap), heartbeatsDuringSpin: hb };
  }
};`.replace("parentTicksIn2.5s", "parentTicks");

app.whenReady().then(async () => {
  protocol.handle("app", (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/parent.js") return new Response(parentJs, { headers: { "content-type": "text/javascript" } });
    const fs = u.searchParams.get("fs") ?? "pigna-visual:";
    return html(page(`<script src="/parent.js"></script>`), PARENT_CSP(fs).replace("script-src 'self'", u.searchParams.get("inline") ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"));
  });
  protocol.handle("pigna-visual", (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/kit.js") return new Response("window.__kit = 1", { headers: { "content-type": "text/javascript" } });
    if (p === "/kit.css") return new Response("body{--kit:1}", { headers: { "content-type": "text/css" } });
    return html(page(`<link rel=stylesheet href="/kit.css"><script src="/kit.js"></script><script>${probe}</script>`), FRAME_CSP);
  });
  void ((_) => _)(() => html(page(`<script>${probe}</script>`), FRAME_CSP));
  const report = { flags: FLAGS };
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const load = async (q) => { await win.loadURL("app://pigna/" + q); };
  const run = (p) => win.webContents.executeJavaScript(`run(${JSON.stringify(p)})`);
  nativeTheme.themeSource = "dark";
  await load("?fs=" + encodeURIComponent("'self' data: blob: about: pigna-visual:"));
  report.a_permissiveFrameSrc = await run("a");
  await load("?fs=pigna-visual:");
  report.b_c = await run("b");
  report.d = await run("d");
  await load("?fs=pigna-visual:"); await win.webContents.executeJavaScript(`window.__links = true`); await run("b"); await new Promise((r) => setTimeout(r, 1200));
  report.links = await win.webContents.executeJavaScript(`window.__allmsgs.filter((m) => m.type.startsWith("after")).map((m) => m.type + ":" + m.data.href)`);
  await load("?fs=pigna-visual:"); report.b_c = await run("b"); report.d = await run("d");
  // f: frame follows nativeTheme, including a live flip while the frame is loaded (listener in probe reports "scheme")
  report.f = {};
  for (const t of ["dark", "light", "dark"]) {
    nativeTheme.themeSource = t; await new Promise((r) => setTimeout(r, 600));
    await load("?fs=pigna-visual:"); const o = await run("b"); report.f["load_" + t] = typeof o === "string" ? o : o.dark ? "dark" : "light";
  }
  await load("?fs=pigna-visual:"); await run("b"); await win.webContents.executeJavaScript(`window.__allmsgs = []`);
  nativeTheme.themeSource = "light"; await new Promise((r) => setTimeout(r, 800));
  report.f.liveFlipToLight = await win.webContents.executeJavaScript(`(window.__allmsgs.find((m) => m.type === "scheme") || {}).data?.dark === false ? "frame saw change -> light" : "no change event"`);
  nativeTheme.themeSource = "dark"; await new Promise((r) => setTimeout(r, 600));
  const win2 = new BrowserWindow({ show: false });
  await win2.loadURL("app://pigna/?fs=" + encodeURIComponent("'self' about:") + "&inline=1");
  report.a_control_parentAllowsInline = await win2.webContents.executeJavaScript(`(async () => { const f = document.createElement("iframe"); f.sandbox = "allow-scripts"; f.srcdoc = "<script>parent.postMessage({type:'ran'},'*')<\\/script>"; let ran = false; addEventListener("message", (e) => e.data?.type === "ran" && (ran = true)); document.body.append(f); await new Promise((x) => setTimeout(x, 600)); return ran; })()`);
  report.processes = app.getAppMetrics().map((m) => m.type).join(",");
  report.a_control_parentAllowsInline = await win2.webContents.executeJavaScript(`(async () => { const f = document.createElement("iframe"); f.sandbox = "allow-scripts"; f.srcdoc = "<script>parent.postMessage({type:'ran'},'*')<\\/script>"; let ran = false; addEventListener("message", (e) => e.data?.type === "ran" && (ran = true)); document.body.append(f); await new Promise((x) => setTimeout(x, 600)); return ran; })()`);
  nativeTheme.themeSource = "dark";
  const cpu = () => app.getAppMetrics().filter((m) => m.type === "Tab").length + " renderer processes";
  const e1 = run("e"); await new Promise((r) => setTimeout(r, 1800)); report.cpuWhileSpinning = cpu(); report.e = await e1;
  await new Promise((r) => setTimeout(r, 1500)); report.cpuAfterFrameRemoved = cpu();
  // same host after the spinning frame was removed
  await load("?fs=pigna-visual:"); const after = await run("b"); report.g_sameHostAfterSpin = typeof after === "string" ? after : "runs";
  // different host (one host per frame) => separate site => separate process?
  await win.webContents.executeJavaScript(`window.__host = "v2"`); const other = await run("b"); report.g_otherHostAfterSpin = typeof other === "string" ? other : "runs";
  // kill the hung process from main: find the frame's OS process and SIGKILL it, then a same-host frame works again
  await load("?fs=pigna-visual:"); await win.webContents.executeJavaScript(`window.__host = "v3"`); await run("b");
  const spin = win.webContents.executeJavaScript(`run("e")`);
  await new Promise((r) => setTimeout(r, 1200));
  const fr = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("pigna-visual:"));
  report.h_frameProcess = { frameFound: !!fr, osPid: fr?.osProcessId, mainPid: win.webContents.mainFrame.osProcessId, separateFromParent: fr && fr.osProcessId !== win.webContents.mainFrame.osProcessId };
  if (fr) process.kill(fr.osProcessId, "SIGKILL");
  await spin.catch(() => {}); await win.webContents.executeJavaScript(`window.__host = "v3"`); const killed = await run("b"); report.h_sameHostAfterKill = typeof killed === "string" ? killed : "runs";
  // frame-src none blocks the scheme (baseline for why DESIGN needs frame-src pigna-visual:)
  await load("?fs=%27none%27"); report.b_frameSrcNone = await run("b");
  console.log(JSON.stringify(report, null, 1));
  app.exit(0);
});
