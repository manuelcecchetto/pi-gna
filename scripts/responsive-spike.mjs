// Throwaway measurement harness for docs/RESPONSIVE_BROWSER.md. Run: node_modules/.bin/electron scripts/responsive-spike.mjs
// Prints one JSON line per measurement ("R <name> <json>"). Not part of the product.
import { app, BrowserWindow, WebContentsView, session, screen } from "electron";
import http from "node:http";

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, ua: req.headers["user-agent"], sec: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("sec-ch"))) });
  res.setHeader("Accept-CH", "Sec-CH-UA-Mobile, Sec-CH-UA-Platform, Sec-CH-UA-Model");
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0"><button id=b style="position:absolute;left:100px;top:100px;width:50px;height:50px">b</button>
<script>
window.clicks=[];addEventListener('click',e=>clicks.push([e.clientX,e.clientY,document.elementFromPoint(e.clientX,e.clientY)?.id||'']));
</script></body>`);
});
const R = (n, v) => console.log("R", n, JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE = `JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,narrow:matchMedia('(max-width: 480px)').matches,coarse:matchMedia('(pointer: coarse)').matches,hover:matchMedia('(hover: none)').matches,ua:navigator.userAgent,touch:navigator.maxTouchPoints,sw:screen.width,sh:screen.height,ob:[outerWidth,outerHeight]})`;
const probe = async (wc) => JSON.parse(await wc.executeJavaScript(PROBE));
const nav = async (wc, url) => { await wc.loadURL(url); };
const send = (wc, m, p) => Promise.race([wc.debugger.sendCommand(m, p), new Promise((_, rj) => setTimeout(() => rj(new Error("TIMEOUT 4s " + m)), 4000))]);

if (process.env.SPIKE_CH) app.commandLine.appendSwitch("enable-features", process.env.SPIKE_CH);
async function main() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const A = `http://127.0.0.1:${server.address().port}`;
  const B = `http://localhost:${server.address().port}`; // different origin (cross-origin nav)
  const ses = session.fromPartition("persist:pigna-spike");
  const win = new BrowserWindow({ width: 1000, height: 800, show: true });
  const view = new WebContentsView({ webPreferences: { session: ses } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const wc = view.webContents;
  wc.debugger.attach("1.3");
  await nav(wc, A + "/a");
  R("0.baseline", await probe(wc));
  const nativeDpr = (await probe(wc)).dpr;

  // a. metrics persistence
  await send(wc, "Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, screenWidth: 393, screenHeight: 852 });
  R("a.applied", await probe(wc));
  await nav(wc, A + "/b"); R("a.afterNav", await probe(wc));
  wc.reload(); await new Promise((r) => wc.once("did-finish-load", r)); R("a.afterReload", await probe(wc));
  await nav(wc, B + "/c"); R("a.crossOrigin", await probe(wc));
  wc.openDevTools({ mode: "detach" }); await sleep(1500);
  R("e.devtoolsOpen", { isDevToolsOpened: wc.isDevToolsOpened(), probe: await probe(wc) });
  // does a command still work while devtools attached?
  R("e.cmdWhileDevtools", (await send(wc, "Runtime.evaluate", { expression: "1+1" })).result);
  wc.closeDevTools(); await sleep(800);
  R("a.afterDevtoolsClose", await probe(wc));
  // render-process-gone / crash: simulate via forcefullyCrashRenderer
  let gone = null; wc.once("render-process-gone", (_e, d) => (gone = d.reason));
  wc.forcefullyCrashRenderer(); await sleep(800);
  wc.reload(); await new Promise((r) => wc.once("did-finish-load", r)); await sleep(200);
  R("a.afterCrashReload", { gone, probe: await probe(wc), attached: wc.debugger.isAttached() });

  // b. UA + client hints + touch
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  await send(wc, "Emulation.setUserAgentOverride", { userAgent: UA, platform: "iPhone", userAgentMetadata: { brands: [{ brand: "Chromium", version: "130" }], fullVersion: "130.0.0.0", platform: "iOS", platformVersion: "17.5", architecture: "", model: "iPhone", mobile: true } });
  await send(wc, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send(wc, "Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }).catch((e) => R("b.emitTouchErr", String(e)));
  seen.length = 0;
  await nav(wc, A + "/ua1"); wc.reload(); await new Promise((r) => wc.once("did-finish-load", r));
  await nav(wc, B + "/ua2");
  R("b.requests", seen.filter((s) => !s.url.includes("favicon")));
  R("b.page", await probe(wc));
  const hi = await wc.executeJavaScript(`navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['model','platformVersion']).then(v=>JSON.stringify({m:navigator.userAgentData.mobile,p:navigator.userAgentData.platform,v})) : 'none'`);
  R("b.uaData", hi);
  // b2. Electron sends no Sec-CH-UA* itself; inject through webRequest, keyed by webContentsId
  ses.webRequest.onBeforeSendHeaders((d, cb) => { const h = { ...d.requestHeaders }; if (d.webContentsId === wc.id) { h["Sec-CH-UA-Mobile"] = "?1"; h["Sec-CH-UA-Platform"] = '"iOS"'; } cb({ requestHeaders: h }); });
  seen.length = 0; await nav(wc, A + "/ch1"); wc.reload(); await new Promise((r) => wc.once("did-finish-load", r)); await nav(wc, B + "/ch2");
  R("b2.injected", seen.filter((x) => !x.url.includes("favicon")).map((x) => [x.url, x.sec]));
  ses.webRequest.onBeforeSendHeaders(null);
  // reset
  await send(wc, "Emulation.setUserAgentOverride", { userAgent: "" });
  await send(wc, "Emulation.setTouchEmulationEnabled", { enabled: false });
  await send(wc, "Emulation.setEmitTouchEventsForMouse", { enabled: false }).catch(() => {});
  seen.length = 0; await nav(wc, A + "/ua3");
  R("b.afterReset", { req: seen[0], ua: (await probe(wc)).ua, touch: (await probe(wc)).touch });

  // c. fit-to-pane. Emulated 1200x800 into a 600x400 pane.
  await nav(wc, A + "/fit");
  for (const mode of ["scale", "clip"]) {
    await send(wc, "Emulation.clearDeviceMetricsOverride");
    const scale = mode === "scale" ? 0.5 : 1;
    await send(wc, "Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false, scale, screenWidth: 1200, screenHeight: 800 });
    view.setBounds({ x: 0, y: 0, width: mode === "scale" ? 600 : 600, height: 400 });
    await sleep(400);
    await wc.executeJavaScript("clicks.length=0");
    const p = await probe(wc);
    // OS-level input: button center is at css (125,125). With scale 0.5 it sits at view (62.5,62.5).
    const target = mode === "scale" ? { x: 63, y: 63 } : { x: 125, y: 125 };
    wc.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await sleep(200);
    const osClicks = await wc.executeJavaScript("JSON.stringify(clicks)");
    await wc.executeJavaScript("clicks.length=0");
    // CDP input in css px (the click at css 125,125)
    for (const t of ["mousePressed", "mouseReleased"]) await send(wc, "Input.dispatchMouseEvent", { type: t, x: 125, y: 125, button: "left", clickCount: 1 });
    await sleep(200);
    const cdpClicks = await wc.executeJavaScript("JSON.stringify(clicks)");
    // far corner reachable? element at css (1100,700)
    const corner = await wc.executeJavaScript("JSON.stringify([innerWidth,innerHeight])");
    const cap = await wc.capturePage(); const csz = cap.getSize(); const bm = cap.toBitmap();
    const px = (x, y) => { const i = (y * csz.width + x) * 4; return [bm[i + 2], bm[i + 1], bm[i]]; };
    const btnPx = mode === "scale" ? px(Math.round(62.5 * csz.width / 600), Math.round(62.5 * csz.width / 600)) : px(Math.round(125 * csz.width / 600), Math.round(125 * csz.width / 600));
    R("c." + mode + ".nativeCapture", { size: csz, btnPixel: btnPx, farCornerPixel: px(csz.width - 4, csz.height - 4) });
    const shot = await send(wc, "Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(shot.data, "base64");
    R("c." + mode, { probe: p, osClicks, cdpClicks, corner, shotPx: [png.readUInt32BE(16), png.readUInt32BE(20)], viewBounds: view.getBounds() });
  }
  // screenshot with scale + captureBeyondViewport / clip
  await send(wc, "Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false, scale: 0.5, screenWidth: 1200, screenHeight: 800 });
  const s2 = await send(wc, "Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1200, height: 800, scale: 1 } });
  const b2 = Buffer.from(s2.data, "base64"); R("c.scaleShotWithClip", [b2.readUInt32BE(16), b2.readUInt32BE(20)]);
  // picker-style elementFromPoint under OS click in scale mode (hover coordinates)
  await wc.executeJavaScript("window.moves=[];addEventListener('mousemove',e=>moves.push([e.clientX,e.clientY]))");
  wc.sendInputEvent({ type: "mouseMove", x: 63, y: 63 }); await sleep(150);
  R("c.scaleHover", await wc.executeJavaScript("JSON.stringify([moves, document.elementFromPoint(moves.at(-1)[0],moves.at(-1)[1]).id])"));

  // d. screenshot dims by DPR, plain and hidden
  const dims = async (tag) => {
    const out = {};
    for (const d of [1, 2, 3]) {
      await send(wc, "Emulation.setDeviceMetricsOverride", { width: 390, height: 600, deviceScaleFactor: d, mobile: true, screenWidth: 390, screenHeight: 600 });
      view.setBounds({ x: 0, y: 0, width: 390, height: 600 }); await sleep(250);
      try { const s = await send(wc, "Page.captureScreenshot", { format: "png" }); const b = Buffer.from(s.data, "base64"); out[d] = [b.readUInt32BE(16), b.readUInt32BE(20)]; } catch (e) { out[d] = String(e); }
    }
    R("d." + tag, out);
  };
  await dims("visible");
  win.minimize(); await sleep(600); await dims("minimized");
  win.restore(); win.hide(); await sleep(600); await dims("hidden");
  // view not attached at all (hidden tab)
  win.show(); win.contentView.removeChildView(view); await sleep(300); await dims("detachedView");
  win.contentView.addChildView(view);
  R("d.capturePageHidden", await (async () => { win.hide(); await sleep(300); try { const i = await Promise.race([wc.capturePage(), sleep(2000).then(() => "timeout")]); win.show(); return i === "timeout" ? i : i.getSize(); } catch (e) { win.show(); return String(e); } })());

  // f. detached window
  await send(wc, "Emulation.clearDeviceMetricsOverride");
  const w2 = new BrowserWindow({ useContentSize: true, width: 393, height: 852, show: false, resizable: true, frame: true });
  w2.setAspectRatio(393 / 852);
  w2.showInactive();
  await sleep(300);
  R("f.window", { content: w2.getContentSize(), bounds: w2.getBounds(), focused: w2.isFocused(), mainFocused: win.isFocused(), display: require_screen().getDisplayMatching(w2.getBounds()).scaleFactor });
  // move existing view into w2
  win.contentView.removeChildView(view);
  w2.contentView.addChildView(view);
  const cs = w2.getContentSize();
  view.setBounds({ x: 0, y: 0, width: cs[0], height: cs[1] });
  await sleep(500);
  R("f.moved", { probe: await probe(wc), attached: wc.debugger.isAttached(), focused: w2.isFocused() });
  await send(wc, "Emulation.setDeviceMetricsOverride", { width: cs[0], height: cs[1], deviceScaleFactor: 3, mobile: true, screenWidth: cs[0], screenHeight: cs[1] });
  await wc.executeJavaScript("clicks.length=0");
  for (const t of ["mousePressed", "mouseReleased"]) await send(wc, "Input.dispatchMouseEvent", { type: t, x: 125, y: 125, button: "left", clickCount: 1 });
  await sleep(150);
  const sh = await send(wc, "Page.captureScreenshot", { format: "png" }); const pb = Buffer.from(sh.data, "base64");
  R("f.emulated", { probe: await probe(wc), clicks: await wc.executeJavaScript("JSON.stringify(clicks)"), shot: [pb.readUInt32BE(16), pb.readUInt32BE(20)], mainStillFocused: win.isFocused(), w2focused: w2.isFocused() });
  // fresh view created directly in w2 with own session, and an exact odd size
  w2.setAspectRatio(0); w2.setContentSize(375, 667); await sleep(300);
  R("f.exactSize", w2.getContentSize());
  w2.setAspectRatio(16 / 9); w2.setContentSize(1280, 720); await sleep(300);
  R("f.aspect16x9", w2.getContentSize());
  w2.setContentSize(1000, 1000); await sleep(300);
  R("f.aspectViolation", w2.getContentSize());
  w2.setContentSize(5000, 3000); await sleep(300);
  R("f.huge", { size: w2.getContentSize(), display: require_screen().getPrimaryDisplay().workAreaSize });
  w2.destroy();
  app.exit(0);
}
function require_screen() { return screen; }
main().catch((e) => { console.log("R FATAL", String(e.stack || e)); app.exit(1); });
