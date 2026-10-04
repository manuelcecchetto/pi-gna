// Throwaway measurement harness for docs/REMOTE_BROWSER_SPIKE.md. Run: node_modules/.bin/electron scripts/remote-browser-spike.mjs
// Prints one JSON line per measurement ("R <state> <json>"). Not part of the product. Uses its own session; never touches user data.
import { app, BrowserWindow, WebContentsView } from "electron";
import http from "node:http";
import { createHash } from "node:crypto";

const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;font:16px sans-serif">
<div id=bar style="position:absolute;top:0;left:0;width:60px;height:60px;background:#e33"></div>
<button id=b style="position:absolute;left:100px;top:200px;width:120px;height:60px">tap</button>
<input id=i style="position:absolute;left:20px;top:300px;width:200px;height:40px">
<canvas id=c width=300 height=200 style="position:absolute;left:20px;top:400px"></canvas>
<script>
window.S={frames:0,mouse:0,touch:0};let x=0;const g=document.getElementById('c').getContext('2d');
(function f(t){S.frames++;x=(x+7)%330;document.getElementById('bar').style.left=x+'px';
for(let k=0;k<30;k++){g.fillStyle='hsl('+((t/5+k*12)%360)+',80%,50%)';g.fillRect(k*10,(t/9+k*7)%200,10,10)}requestAnimationFrame(f)})(0);
b.addEventListener('mousedown',()=>S.mouse++);b.addEventListener('touchstart',()=>S.touch++);i.focus();
</script></body>`;
const server = http.createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end(PAGE); });
const R = (n, v) => console.log("R", n, JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmo = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error("TIMEOUT " + what)), ms))]);

async function main() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ width: 1000, height: 900, show: true });
  const view = new WebContentsView({ webPreferences: { partition: "persist:remote-browser-spike", sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 390, height: 844 });
  const wc = view.webContents;
  wc.debugger.attach("1.3");
  const send = (m, p) => tmo(wc.debugger.sendCommand(m, p), 4000, m);
  await wc.loadURL(url);
  await send("Page.enable");
  const page = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;

  let frameCount = 0, frameBytes = 0;
  const distinct = new Set(); // distinct frame hashes: tells real new content from repeated frames
  wc.debugger.on("message", async (_e, m, p) => {
    if (m !== "Page.screencastFrame") return;
    distinct.add(createHash("md5").update(p.data).digest("hex")); frameCount++; frameBytes += p.data.length * 0.75;
    send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });

  async function screencast(ms = 3000) {
    frameCount = 0; frameBytes = 0; distinct.clear();
    try {
      await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1170, maxHeight: 2532, everyNthFrame: 1 });
      await sleep(ms);
      await send("Page.stopScreencast");
    } catch (e) { return { error: String(e) }; }
    return { fps: +(frameCount / (ms / 1000)).toFixed(1), kbPerFrame: frameCount ? +(frameBytes / frameCount / 1024).toFixed(1) : 0, frames: frameCount, distinct: distinct.size };
  }
  async function shots(scale, n = 20) {
    const lat = []; let bytes = 0; const t0 = Date.now();
    try {
      for (let i = 0; i < n; i++) {
        const t = Date.now();
        const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 390, height: 844, scale }, captureBeyondViewport: false });
        lat.push(Date.now() - t); bytes += r.data.length * 0.75;
      }
    } catch (e) { return { error: String(e), done: lat.length }; }
    lat.sort((a, b) => a - b);
    return { fps: +(n / ((Date.now() - t0) / 1000)).toFixed(1), p50ms: lat[n >> 1], maxms: lat[n - 1], kbPerFrame: +(bytes / n / 1024).toFixed(1) };
  }
  async function input() {
    const out = {};
    const before = await page("JSON.stringify(S)").then(JSON.parse).catch(() => null);
    const tryit = async (k, fn) => { try { await fn(); out[k] = "ok"; } catch (e) { out[k] = String(e); } };
    await tryit("mouse", async () => { for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 150, y: 230, button: "left", clickCount: 1 }); });
    await tryit("touch", async () => { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: 230 }] }); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); });
    await tryit("text", async () => { await page("document.getElementById('i').value='';document.getElementById('i').focus()"); await send("Input.insertText", { text: "hi" }); });
    await sleep(200);
    const after = await page("JSON.stringify({...S,val:document.getElementById('i').value})").then(JSON.parse).catch(() => null);
    return { ...out, mouseSeen: after && before ? after.mouse - before.mouse : null, touchSeen: after && before ? after.touch - before.touch : null, textSeen: after?.val };
  }
  async function measure(state) {
    const raf0 = await page("S.frames").catch(() => -1); await sleep(1000); const raf1 = await page("S.frames").catch(() => -1);
    R(state + ".page", { rafPerSec: raf1 - raf0, visibilityState: await page("document.visibilityState").catch(() => "?") });
    R(state + ".screencast", await screencast());
    R(state + ".shot@3x", await shots(3 * 1)); // clip scale 3 => 1170x2532
    R(state + ".shot@2x", await shots(2));
    R(state + ".input", await input());
  }

  await sleep(500);
  await measure("1.visible");

  win.hide(); await sleep(800);
  await measure("2.windowHidden");
  R("2.capturePage", await tmo(wc.capturePage(), 3000, "capturePage").then((i) => i.getSize(), (e) => String(e)));
  R("2.sendInputEvent", await (async () => { const b = await page("S.mouse"); wc.sendInputEvent({ type: "mouseDown", x: 150, y: 230, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: 150, y: 230, button: "left", clickCount: 1 }); await sleep(200); return (await page("S.mouse")) - b; })());
  win.show(); await sleep(500);

  win.minimize(); await sleep(800);
  await measure("3.minimized");
  win.restore(); await sleep(500);

  // occluded: a larger opaque always-on-top window covers the host window completely
  const cover = new BrowserWindow({ x: win.getBounds().x - 50, y: win.getBounds().y - 50, width: 1200, height: 1100, show: false, frame: false });
  cover.setAlwaysOnTop(true, "screen-saver"); cover.showInactive(); await sleep(1500);
  R("4.occlusionState", { hostVisible: win.isVisible(), coverVisible: cover.isVisible() });
  await measure("4.occluded");
  cover.destroy(); await sleep(500);

  win.contentView.removeChildView(view); await sleep(800);
  await measure("5.viewDetached");
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 390, height: 844 }); await sleep(500);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(500);
  await measure("6.emulatedMobile.visible");
  win.hide(); await sleep(800); await measure("7.emulatedMobile.windowHidden");
  win.show(); win.contentView.removeChildView(view); await sleep(800); await measure("8.emulatedMobile.viewDetached");
  // parking candidates for a tab whose pane is closed: keep it in the window tree but not drawn
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 390, height: 844 }); view.setVisible(false); await sleep(800);
  await measure("9.emulatedMobile.setVisibleFalse");
  view.setVisible(true); view.setBounds({ x: -5000, y: -5000, width: 390, height: 844 }); await sleep(800);
  await measure("10.emulatedMobile.offscreenBounds");
  win.hide(); await sleep(800); await measure("11.emulatedMobile.offscreenBounds.windowHidden");
  app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
