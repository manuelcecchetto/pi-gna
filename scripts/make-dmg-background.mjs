// Draw the DMG installer window background (build/dmg-background.png and @2x): the pigna hand of the 🤌i mark
// (src/renderer/src/assets/pigna-hand.svg) "dragging" along a dotted trail from the app icon slot to the Applications slot. Finder cannot
// animate a background, so the hand is frozen mid-drag with a motion trail. The window and icon positions are in
// electron-builder.yml (dmg.window, dmg.contents) and must match WIDTH, HEIGHT and the trail below.
// Runs in Electron like make-icon.mjs. Usage: pnpm dmg-background
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const WIDTH = 540;
const HEIGHT = 380;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mark = readFileSync(join(root, "src", "renderer", "src", "assets", "pigna-hand.svg"), "utf8");
const turned = /<g transform="matrix\(0 -1 -1 0 36 36\)">.*<\/g>/s.exec(mark)?.[0];
if (!turned) throw new Error("pigna-hand.svg no longer has the turned Twemoji <g> this script lifts out");
// Placed as the old icon placed it (a 540px box at 180, 243.5 of its 1024px tile), so the offsets below still hold.
const hand = `<svg x="180.0" y="243.5" width="540" height="540" viewBox="0 0 36 36">${turned}</svg>`;

const dots = [0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${196 + i * 9}" cy="${146 - Math.sin(i / 5 * Math.PI) * 10}" r="${2 + i * 0.6}" fill="#E0614F" opacity="${0.25 + i * 0.13}"/>`).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55"/></filter></defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f6f3ef"/>
  <g filter="url(#glow)"><circle cx="40" cy="30" r="110" fill="#F09082" opacity="0.35"/><circle cx="520" cy="340" r="130" fill="#4D9ABF" opacity="0.3"/><circle cx="60" cy="360" r="70" fill="#F1BE58" opacity="0.3"/></g>
  ${dots}
  <g transform="translate(251 94) scale(0.16)"><g transform="translate(-180 -243.5)">${hand}</g></g>
  <text x="${WIDTH / 2}" y="${HEIGHT - 110}" text-anchor="middle" fill="#1d1d22" font-family="-apple-system, Helvetica Neue, sans-serif" font-size="17" font-weight="600">Pinch pi-gna into Applications</text>
  <text x="${WIDTH / 2}" y="${HEIGHT - 88}" text-anchor="middle" fill="#1d1d22" opacity="0.55" font-family="-apple-system, Helvetica Neue, sans-serif" font-size="12">Drag the icon on the left onto the folder on the right</text>
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
