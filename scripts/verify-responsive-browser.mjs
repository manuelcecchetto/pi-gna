#!/usr/bin/env node
// Dev tool: end-to-end check of the responsive browser through the real app. Run after `pnpm build`:
//   node scripts/verify-responsive-browser.mjs
// Starts a fixture HTTP server and a throwaway app instance (fake pi, which hands its bridge token to this script),
// drives the browser_* bridge the way the agent tools do, and prints a pass/fail table. Exit code 1 on any failure.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pigna-verify-"));
const port = 9478;
const inspect = 9479;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rows = [];
const check = (name, ok, detail = "") => {
  rows.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
};

// Fixture: the server reports what it was sent; the page reports what it sees.
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, ua: req.headers["user-agent"] ?? "", mobile: req.headers["sec-ch-ua-mobile"] });
  res.setHeader("Accept-CH", "Sec-CH-UA-Mobile");
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>fixture ${req.url}</title>
<body style="margin:0"><h1>${/Mobile/i.test(req.headers["user-agent"] ?? "") ? "MOBILE" : "DESKTOP"} ${req.url}</h1><pre id=out></pre>
<button id=target style="margin:300px 0 0 150px;width:80px;height:40px" onclick="window.hit=(window.hit||0)+1">Target</button>
<script>window.probe=()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,coarse:matchMedia('(pointer: coarse)').matches,ua:navigator.userAgent})</script></body>`);
});
await new Promise((open) => server.listen(0, "127.0.0.1", open));
const base = `http://127.0.0.1:${server.address().port}`;

// A pi stand-in that leaves its bridge address and token behind, then behaves like fake pi.
const pi = join(work, "pi.mjs");
writeFileSync(pi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(work, "env.json"))}, JSON.stringify({ url: process.env.PIGNA_BRIDGE, token: process.env.PIGNA_TOKEN }));\nawait import(${JSON.stringify(join(root, "scripts", "fake-pi.mjs"))});\n`);
chmodSync(pi, 0o755);

const app = spawn("node", [join(root, "bin", "pi-gna.mjs"), `--remote-debugging-port=${port}`, `--inspect=${inspect}`], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, PIGNA_USER_DATA: join(work, "profile"), PIGNA_BACKGROUND: "1", PIGNA_CWD: root, PIGNA_PI_BIN: pi },
});

let bridge;
async function call(body) {
  const response = await fetch(`${bridge.url}/browser`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}
/** Click the fixture's Target button through the bridge, with a deadline: a click that never acks must fail, not hang. */
async function clickTarget(tab) {
  const deadline = (ms) => new Promise((_, fail) => setTimeout(() => fail(new Error("click timed out")), ms));
  const snap = await call({ action: "snapshot", tab });
  const ref = /\[(\d+)\] button "Target"/.exec(snap.text ?? "")?.[1];
  if (!ref) return { ok: false, detail: "no Target ref in the snapshot" };
  await Promise.race([call({ action: "click", ref: Number(ref), tab }), deadline(8000)]);
  const hits = (await call({ action: "evaluate", expression: "String(window.hit || 0)", tab })).text;
  await call({ action: "evaluate", expression: "window.hit = 0", tab });
  return { ok: hits === "1", detail: `ref ${ref}, ${hits} hit(s)` };
}
const probe = async (tab) => JSON.parse((await call({ action: "evaluate", expression: "JSON.stringify(probe())", tab })).text);

// The main process, through Node's inspector.
let mainWs;
let seq = 0;
const waiting = new Map();
async function main(expression) {
  if (!mainWs) {
    const [target] = await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json();
    mainWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((open) => (mainWs.onopen = open));
    mainWs.onmessage = (event) => {
      const message = JSON.parse(event.data);
      waiting.get(message.id)?.(message);
    };
  }
  const id = ++seq;
  const answer = new Promise((done) => waiting.set(id, done));
  mainWs.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  const message = await answer;
  if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? "main eval failed");
  return message.result?.result?.value;
}
// The app's renderer (the toolbar's IPC surface, window.studio), through the app window's CDP target.
async function renderer(expression) {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith("app://"));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open) => (ws.onopen = open));
  const answer = new Promise((done) => (ws.onmessage = (event) => done(JSON.parse(event.data))));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  const message = await answer;
  ws.close();
  if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? "renderer eval failed");
  return message.result?.result?.value;
}
// The pane view's native bounds and the size its page actually paints (capturePage, in DIPs); they differ when Chromium
// resized the surface to the emulated size, which shows as a blank strip past the fitted rect.
const paneSurface = () =>
  main(`(async () => {
    const { BrowserWindow, screen } = process.mainModule.require("electron");
    const app = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://"));
    const view = app.contentView.children.find((child) => child.webContents && !child.webContents.getURL().startsWith("app://"));
    const image = await view.webContents.capturePage();
    const factor = screen.getDisplayMatching(app.getBounds()).scaleFactor;
    const { width, height } = view.getBounds();
    return { bounds: [width, height], painted: [Math.round(image.getSize().width / factor), Math.round(image.getSize().height / factor)] };
  })()`);
const sameSurface = (s) => Math.abs(s.bounds[0] - s.painted[0]) <= 1 && Math.abs(s.bounds[1] - s.painted[1]) <= 1;
const windowTitles = () =>
  main(`(() => { const { BrowserWindow } = process.mainModule.require("electron"); return BrowserWindow.getAllWindows().map((w) => w.getTitle()).filter((t) => t !== "pi-gna"); })()`);
const windows = () =>
  main(`(() => { const { BrowserWindow } = process.mainModule.require("electron"); return BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().startsWith("app://") && !w.webContents.getURL().includes("5173")).map((w) => ({ size: w.getContentSize(), focused: w.isFocused() })); })()`);

// JPEG dimensions from its SOF marker.
function jpegSize(base64) {
  const bytes = Buffer.from(base64, "base64");
  for (let i = 2; i < bytes.length; ) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
}
const capped = (w, h, max = 1600) => {
  const long = Math.max(w, h);
  return long <= max ? { width: w, height: h } : { width: Math.round((w * max) / long), height: Math.round((h * max) / long) };
};

try {
  for (let i = 0; i < 400 && !bridge; i++) {
    await sleep(100);
    try {
      bridge = JSON.parse(readFileSync(join(work, "env.json"), "utf8"));
    } catch {}
  }
  if (!bridge) throw new Error("the app never started a session (no bridge token)");
  await sleep(1500);

  await call({ action: "open", url: `${base}/a` });
  const native = await probe();
  check("native: real viewport reported", native.w > 300 && !/Mobile/i.test(native.ua), `${native.w}x${native.h} @${native.dpr}x`);

  // iphone-15: viewport, DPR, coarse pointer, and the UA the server sees after the reload
  const set = await call({ action: "viewport", set: { preset: "iphone-15" } });
  check("iphone-15: result carries the preset viewport", set.viewport?.width === 393 && set.viewport?.height === 852 && set.viewport?.dpr === 3 && set.viewport?.label === "iPhone 15", JSON.stringify(set.viewport));
  await sleep(1500);
  const phone = await probe();
  check("iphone-15: page sees 393x852 @3x", phone.w === 393 && phone.h === 852 && phone.dpr === 3, `${phone.w}x${phone.h} @${phone.dpr}x`);
  check("iphone-15: coarse pointer", phone.coarse === true);
  check("iphone-15: navigator UA is iPhone", /iPhone/.test(phone.ua), phone.ua);
  const ssr = requests.filter((r) => r.url === "/a").at(-1);
  check("iphone-15: server saw mobile UA after reload", /iPhone/.test(ssr.ua) && /Mobile/.test(ssr.ua), `UA ${ssr.ua.slice(0, 60)}… sec-ch-ua-mobile ${ssr.mobile}`);
  check("iphone-15: page rendered the mobile variant", /MOBILE/.test((await call({ action: "snapshot" })).text ?? ""));

  // an agent click lands on the element under touch emulation (taps, not mouse presses that never ack)
  const tap = await clickTarget();
  check("iphone-15: click hits its element", tap.ok, tap.detail);

  // the viewport survives a navigation
  await call({ action: "open", url: `${base}/b` });
  await sleep(500);
  const afterNav = await probe();
  check("viewport survives navigation", afterNav.w === 393 && afterNav.dpr === 3 && /iPhone/.test(requests.filter((r) => r.url === "/b").at(-1).ua), `${afterNav.w}x${afterNav.h} @${afterNav.dpr}x`);

  // screenshot size
  const shot = await call({ action: "screenshot" });
  const size = jpegSize(shot.image);
  const want = capped(393 * 3, 852 * 3);
  check("screenshot: iphone-15 size capped to 1600", !!size && Math.abs(size.width - want.width) <= 2 && Math.abs(size.height - want.height) <= 2, `${size?.width}x${size?.height}, want ${want.width}x${want.height}`);

  // aspect + width + dpr
  const wide = await call({ action: "viewport", set: { aspect: "16:9", width: 1280, dpr: 2 } });
  check("16:9 @ 1280 gives height 720", wide.viewport?.width === 1280 && wide.viewport?.height === 720 && wide.viewport?.dpr === 2, JSON.stringify(wide.viewport));
  await sleep(1000);
  const wideProbe = await probe();
  check("16:9: page sees 1280x720 @2x, desktop UA", wideProbe.w === 1280 && wideProbe.h === 720 && wideProbe.dpr === 2 && !/iPhone/.test(wideProbe.ua), `${wideProbe.w}x${wideProbe.h} @${wideProbe.dpr}x`);
  // a viewport larger than the pane is fitted below scale 1; the click must be scaled with it
  const big = await call({ action: "viewport", set: { width: 2400, height: 1600 } });
  await sleep(1000);
  const fitted = await clickTarget();
  check("fit below 1: click hits its element", big.viewport?.width === 2400 && fitted.ok, fitted.detail);
  const fitSurface = await paneSurface();
  check("fit below 1: page paints the view's bounds", sameSurface(fitSurface), JSON.stringify(fitSurface));
  await call({ action: "open", url: `${base.replace("127.0.0.1", "localhost")}/x` });
  await sleep(1000);
  const navSurface = await paneSurface();
  check("fit below 1: still after a cross-origin navigation", sameSurface(navSurface), JSON.stringify(navSurface));
  await call({ action: "viewport", set: { aspect: "16:9", width: 1280, dpr: 2 } });
  await sleep(1000);
  const wideShot = jpegSize((await call({ action: "screenshot" })).image);
  const wideWant = capped(2560, 1440);
  check("screenshot: 16:9 size capped to 1600", !!wideShot && Math.abs(wideShot.width - wideWant.width) <= 2 && Math.abs(wideShot.height - wideWant.height) <= 2, `${wideShot?.width}x${wideShot?.height}, want ${wideWant.width}x${wideWant.height}`);

  // agent window
  const before = (await windows()).length;
  const opened = await call({ action: "window", op: "open", url: `${base}/w`, set: { width: 360, aspect: "9:16", dpr: 3 } });
  check("window: result viewport 360x640 @3x", opened.viewport?.width === 360 && opened.viewport?.height === 640 && opened.viewport?.dpr === 3, JSON.stringify(opened.viewport));
  await sleep(1000);
  const win = await probe(opened.tab);
  check("window: page sees 360x640 @3x", win.w === 360 && win.h === 640 && win.dpr === 3, `${win.w}x${win.h} @${win.dpr}x`);
  const after = await windows();
  const spawned = after.at(-1);
  check("window: content size is 360x640", after.length === before + 1 && spawned.size[0] === 360 && spawned.size[1] === 640, JSON.stringify(spawned?.size));
  check("window: did not take focus", after.length === before + 1 && spawned.focused === false);
  const winShot = jpegSize((await call({ action: "screenshot", tab: opened.tab })).image);
  const winWant = capped(1080, 1920);
  check("screenshot: window size capped to 1600", !!winShot && Math.abs(winShot.width - winWant.width) <= 2 && Math.abs(winShot.height - winWant.height) <= 2, `${winShot?.width}x${winShot?.height}, want ${winWant.width}x${winWant.height}`);
  await call({ action: "window", op: "close", tab: opened.tab });
  await sleep(300);
  check("window: close removes it", (await windows()).length === before);
  const failed = await call({ action: "window", op: "open", url: "http://127.0.0.1:1/", set: { width: 400, height: 400 } }).then(() => "opened", (error) => error.message);
  await sleep(500);
  const left = (await windows()).length;
  check("window: failed load leaves no window", failed !== "opened" && left === before, `${failed}; ${left} windows`);

  // the user's pop-out keeps the device (label, Android UA); toolbar edits keep the UA and retitle the window
  await call({ action: "viewport", set: { preset: "pixel-8" } });
  await sleep(1500);
  const paneTab = await renderer("studio.browser.state().then((s) => s.activeId)");
  await renderer(`studio.browser.popOut(${JSON.stringify(paneTab)})`);
  await sleep(1000);
  const popped = await probe();
  check("pop-out: keeps the Pixel's Android UA", /Android/.test(popped.ua) && popped.dpr === 2.625, `${popped.w}x${popped.h} @${popped.dpr}x ${popped.ua.slice(13, 40)}`);
  check("pop-out: window titled with the preset", (await windowTitles()).includes("Pixel 8 412x915 @2.625x"), JSON.stringify(await windowTitles()));
  const edited = await renderer(`studio.browser.viewport(${JSON.stringify(paneTab)}, { width: 360, height: 640, dpr: 2.625, mobile: true, userAgent: "android", source: "user" })`);
  await sleep(1500);
  const resized = await probe();
  check("toolbar edit: keeps the Android UA", edited?.userAgent === "android" && /Android/.test(resized.ua) && resized.w === 360, `${resized.w}x${resized.h} ${resized.ua.slice(13, 40)}`);
  check("toolbar edit: window retitled", (await windowTitles()).includes("Custom 360x640 @2.625x"), JSON.stringify(await windowTitles()));
  await renderer(`studio.browser.returnToPane(${JSON.stringify(paneTab)})`);
  await sleep(500);
  check("return to pane: window closed", (await windows()).length === before);

  // reset restores the real values
  const reset = await call({ action: "viewport", reset: true });
  check("reset: result has no viewport", reset.viewport === undefined);
  await sleep(1500);
  const back = await probe();
  check("reset: real viewport, DPR and UA restored", back.w === native.w && back.h === native.h && back.dpr === native.dpr && back.ua === native.ua && back.coarse === native.coarse, `${back.w}x${back.h} @${back.dpr}x`);
} catch (error) {
  check("run", false, error instanceof Error ? `${error.message}${error.cause ? ` (${error.cause})` : ""}` : String(error));
} finally {
  mainWs?.close();
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
