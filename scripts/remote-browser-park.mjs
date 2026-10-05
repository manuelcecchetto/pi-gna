// Where can a tab be parked (in the window's view tree, not shown) while a remote viewer watches it?
// Measures page rAF/s, screencast fps and whether a CDP tap lands for a few parking rects.
// Run: node_modules/.bin/electron scripts/remote-browser-park.mjs   (own session; never touches user data)
import { app, BrowserWindow, WebContentsView } from "electron";
import http from "node:http";

const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0">
<button id=b style="position:absolute;left:100px;top:200px;width:120px;height:60px">tap</button>
<script>window.S={frames:0,touch:0,mouse:0};(function f(){S.frames++;requestAnimationFrame(f)})();
b.addEventListener('touchstart',()=>S.touch++);b.addEventListener('mousedown',()=>S.mouse++);</script></body>`;
const server = http.createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end(PAGE); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmo = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error("TIMEOUT " + what)), ms))]);

async function main() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const win = new BrowserWindow({ width: 1000, height: 900, show: true });
  const view = new WebContentsView({ webPreferences: { partition: "persist:remote-browser-park", sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.debugger.attach("1.3");
  const send = (m, p) => tmo(wc.debugger.sendCommand(m, p), 4000, m);
  await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const page = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
  let frames = 0;
  wc.debugger.on("message", (_e, m, p) => { if (m === "Page.screencastFrame") { frames++; send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {}); } });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.enable");
  await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1170, maxHeight: 2532, everyNthFrame: 2 });
  const W = 1000;
  const candidates = {
    "full window width, behind nothing": { x: 0, y: 0, width: 1000, height: 900 },
    "right edge, 20px inside": { x: W - 20, y: 0, width: 390, height: 844 },
    "shown 390x844": { x: 0, y: 0, width: 390, height: 844 },
    "right edge, 1px inside": { x: W - 1, y: 0, width: 390, height: 844 },
    "bottom edge, 1px inside": { x: 0, y: 899, width: 390, height: 844 },
    "1x1 at 0,0 (viewport emulated)": { x: 0, y: 0, width: 1, height: 1 },
    "far offscreen": { x: -5000, y: -5000, width: 390, height: 844 },
  };
  const seen = [];
  wc.debugger.on("message", (_e, m, p) => { if (m === "Page.screencastVisibilityChanged") seen.push(p.visible); });
  for (const hidden of [false, true]) {
   if (hidden) win.hide();
   console.log("R window", hidden ? "hidden" : "shown");
   for (const [name, bounds] of Object.entries(candidates)) {
    view.setBounds(bounds); await sleep(600);
    const raf0 = await page("S.frames"); frames = 0; const t0 = Date.now(); await sleep(1500);
    const raf1 = await page("S.frames");
    const secs = (Date.now() - t0) / 1000;
    const before = await page("S.touch"); let tap = "ok";
    try { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: 230 }] }); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); } catch (e) { tap = String(e); }
    await sleep(200);
    console.log("R", name, JSON.stringify({ rafPerSec: +((raf1 - raf0) / secs).toFixed(1), screencastFps: +(frames / secs).toFixed(1), tap, touchSeen: (await page("S.touch")) - before, visibility: seen.splice(0) }));
   }
  }
  app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
