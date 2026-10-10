// Draw the DMG installer window background (build/dmg-background.png and @2x) from build/dmg-art.webp: two Pignas,
// a big arrow between the icon slots and the lettered "Drag pi-gna into Applications" (the text is part of the art).
// The art was generated like the site's mascot poses (site/tools/mascot/README.md) against a layout guide that kept
// the icon slots and their labels empty. The window and icon positions are in electron-builder.yml (dmg.window,
// dmg.contents: 540x380, 100px icons at x 140 and 400, y 140); new art must leave those slots empty again.
// Runs in Electron like make-icon.mjs. Usage: pnpm dmg-background
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const WIDTH = 540;
const HEIGHT = 380;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const art = readFileSync(join(root, "build", "dmg-art.webp")).toString("base64");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <image href="data:image/webp;base64,${art}" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice"/>
</svg>`;

app.dock?.hide();
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const page = `<html><body style="margin:0">${svg}</body></html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
  await new Promise((settle) => setTimeout(settle, 300));
  mkdirSync(join(root, "build"), { recursive: true });
  window.webContents.setZoomFactor(1);
  const shot = await window.webContents.capturePage();
  writeFileSync(join(root, "build", "dmg-background.png"), shot.resize({ width: WIDTH, height: HEIGHT }).toPNG());
  window.webContents.setZoomFactor(2);
  window.setContentSize(WIDTH * 2, HEIGHT * 2);
  await new Promise((settle) => setTimeout(settle, 300));
  writeFileSync(join(root, "build", "dmg-background@2x.png"), (await window.webContents.capturePage()).resize({ width: WIDTH * 2, height: HEIGHT * 2 }).toPNG());
  app.quit();
});
