// Render resources/icon.svg's tile full bleed into the PWA icons under src/mobile/public/icons (committed): a square,
// opaque, without the macOS icon's transparent margin and rounded corners. iOS and Android round the icon themselves,
// and iOS fills a transparent apple-touch-icon, which showed as a light ring around the macOS tile. apple-touch-icon
// is 180px; the manifest lists 192 and 512. Runs in Electron like make-icon.mjs. Usage: pnpm icon:mobile
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "mobile", "public", "icons");
// The tile is the 824px square at 100,100 of the 1024px icon; drop its rounded clip and frame only that square.
const icon = readFileSync(join(root, "resources", "icon.svg"), "utf8");
const square = icon.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"').replace(' clip-path="url(#tile)"', "");
if (square.includes('clip-path="url(#tile)"') || !square.includes('viewBox="100 100 824 824"')) {
  throw new Error("resources/icon.svg no longer has the 1024px viewBox and the tile clip this script takes off");
}
const svg = Buffer.from(square).toString("base64");

app.dock?.hide();
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const page = `<html><body style="margin:0"><img src="data:image/svg+xml;base64,${svg}" width="1024" height="1024"></body></html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
  await new Promise((settle) => setTimeout(settle, 300));
  const full = (await window.webContents.capturePage()).resize({ width: 1024, height: 1024 });
  mkdirSync(out, { recursive: true });
  for (const [name, size] of [["apple-touch-icon", 180], ["icon-192", 192], ["icon-512", 512]]) {
    const file = join(out, `${name}.png`);
    writeFileSync(file, full.resize({ width: size, height: size, quality: "best" }).toPNG());
    console.log(file);
  }
  app.quit();
});
