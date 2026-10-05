// Integration check for the host side of the remote browser (src/main/browser/remote-view.ts) against a local fixture,
// with the desktop window HIDDEN and the browser pane closed: frames arrive, taps/text/keys/scroll land under touch
// emulation and without, comment mode returns an annotation with a crop, and closing the viewer stops the screencast.
// Run: node_modules/.bin/electron scripts/remote-browser-check.mjs   (own userData in the temp dir; exit code 0 = all ok)
import { app, BrowserWindow } from "electron";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(realpathSync(tmpdir()), "pigna-remote-browser-"));
app.setPath("userData", join(work, "ud"));
app.setName("pigna-remote-browser-check");

const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;height:3000px">
<div id=bar style="position:fixed;top:0;left:0;width:60px;height:30px;background:#e33"></div>
<button id=b style="position:absolute;left:100px;top:200px;width:120px;height:60px">tap me</button>
<input id=i style="position:absolute;left:20px;top:300px;width:200px;height:40px">
<script>
window.S={touch:0,mouse:0,click:0,keys:0};let x=0;
(function f(){x=(x+7)%300;bar.style.left=x+'px';requestAnimationFrame(f)})();
b.addEventListener('touchstart',()=>S.touch++);b.addEventListener('mousedown',()=>S.mouse++);b.addEventListener('click',()=>S.click++);
addEventListener('keydown',()=>S.keys++);
</script></body>`;
const server = http.createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end(PAGE); });

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (probe, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await probe(); if (v) return v; if (Date.now() > end) return false; await sleep(50); } };

async function bundle() {
  const { build } = await import(join(root, "node_modules/vite/dist/node/index.js"));
  const entry = join(work, "entry.ts");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(entry, `export { BrowserManager } from ${JSON.stringify(join(root, "src/main/browser/manager.ts"))};\nexport { RemoteBrowser } from ${JSON.stringify(join(root, "src/main/browser/remote-view.ts"))};\n`);
  await build({ root, logLevel: "error", configFile: false, build: { ssr: entry, outDir: join(work, "out"), emptyOutDir: true, minify: false, rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } } } });
  return import(join(work, "out/entry.mjs"));
}

async function main() {
  await app.whenReady();
  const { BrowserManager, RemoteBrowser } = await bundle();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const window = new BrowserWindow({ width: 1000, height: 800, show: true });
  await sleep(1000); // a window that was on screen once, like the app's after the user closed it
  window.hide();
  await sleep(500);
  const manager = new BrowserManager(window, { state: () => {}, reveal: () => {}, annotation: () => {} });
  const tab = manager.createTab(url);
  const wc = tab.view.webContents;
  await until(() => !wc.isLoading() && wc.getURL() === url);
  const page = (expression) => wc.executeJavaScript(expression);
  const remote = new RemoteBrowser(manager);

  console.log("window hidden, pane closed (no layout set)");
  check(!window.isVisible(), "desktop window is hidden");
  let frames = 0;
  let last;
  const handle = remote.open(tab.id, { width: 390, height: 844, dpr: 2 }, (f) => { frames++; last = f; });
  check(await until(() => frames >= 10), "screencast frames arrive", frames);
  check(manager.parked.size === 1 && manager.keeper && !manager.keeper.isDestroyed(), "tab is parked in the keeper window for the viewer");
  check(last && last.jpeg.length > 100 && last.jpeg[0] === 0xff && last.jpeg[1] === 0xd8, "frames are JPEGs");
  check(last && last.cssWidth > 0 && last.cssHeight > 0, "frames carry the page size", last && [last.cssWidth, last.cssHeight]);

  console.log("mouse input (no emulation)");
  await remote.input(tab.id, { type: "tap", x: 110, y: 230 });
  check(await until(async () => (await page("S.click")) === 1), "tap clicks the button", await page("JSON.stringify(S)"));
  await remote.input(tab.id, { type: "tap", x: 30, y: 320 });
  await remote.input(tab.id, { type: "text", text: "hi" });
  check(await until(async () => (await page("i.value")) === "hi"), "text goes into the focused input", await page("i.value"));
  await remote.input(tab.id, { type: "key", key: "Backspace" });
  check(await until(async () => (await page("i.value")) === "h"), "key press lands");
  await remote.input(tab.id, { type: "scroll", x: 100, y: 400, dx: 0, dy: 400 });
  check(await until(async () => (await page("scrollY")) > 100), "scroll moves the page", await page("scrollY"));
  await page("scrollTo(0,0)");

  console.log("touch emulation (iPhone 15 preset, source user)");
  await manager.setViewport(tab.id, { preset: "iphone-15", source: "user" });
  await until(() => !wc.isLoading());
  check(manager.parked.size === 1 && tab.emulatedScale === 1, "parked at full size, scale 1", tab.emulatedScale);
  const before = await page("S.touch");
  await remote.input(tab.id, { type: "tap", x: 110, y: 230 });
  check(await until(async () => (await page("S.touch")) === before + 1), "tap becomes a touch under touch emulation", await page("JSON.stringify(S)"));
  const frameBefore = frames;
  await sleep(1000);
  check(frames - frameBefore >= 10, "frames keep coming under emulation with the window hidden", frames - frameBefore);

  console.log("comment mode");
  const picked = await remote.input(tab.id, { type: "pick", x: 110, y: 230, comment: "make this bigger" });
  const a = picked?.annotation;
  check(a && a.comment === "make this bigger" && a.selector === "#b" && a.label.includes("tap me") && a.url === url, "pick describes the element", a && { ...a, image: undefined });
  check(a && typeof a.image === "string" && a.image.length > 100, "pick carries a crop from the frame");
  const empty = await remote.input(tab.id, { type: "pick", x: 5, y: 5, comment: "x" }).then(() => "picked", (e) => e.message);
  check(empty === "No element at that point", "pick on the bare body is refused", empty);
  const noComment = await remote.input(tab.id, { type: "pick", x: 110, y: 230, comment: "  " }).then(() => "picked", (e) => e.message);
  check(noComment === "A comment is required", "pick without a comment is refused", noComment);

  console.log("desktop window shown while watched: nothing changes for the viewer, nothing covers the desktop");
  window.showInactive();
  await sleep(500);
  check(!window.contentView.children.includes(tab.view), "the tab does not enter the desktop window");
  const shownBefore = frames;
  await sleep(1000);
  check(frames - shownBefore >= 10, "frames keep coming with the window shown", frames - shownBefore);
  const touched = await page("S.touch");
  await remote.input(tab.id, { type: "tap", x: 110, y: 230 });
  check(await until(async () => (await page("S.touch")) === touched + 1), "tap lands with the window shown");
  window.hide();

  console.log("viewer leaves");
  handle.close();
  check(await until(() => manager.parked.size === 0) && !manager.keeper, "tab is released and the keeper window is gone");
  await sleep(300);
  const settled = frames;
  await sleep(700);
  check(frames === settled, "no frames after the viewer left", frames - settled);
  check(remote.watching === 0, "no screencast left running");
  await remote.input(tab.id, { type: "tap", x: 110, y: 230 });
  check(manager.parked.size === 0, "input without a viewer parks only for the call");

  console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
  manager.destroy();
  server.close();
  rmSync(work, { recursive: true, force: true });
  app.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); app.exit(1); });
