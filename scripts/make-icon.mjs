// Rasterize resources/icon.svg (the source of truth) into resources/icon.png (1024px, dev Dock icon) and
// build/icon.icns (the packaged app). Runs in Electron so the SVG renders exactly as Chromium draws it;
// sips and iconutil ship with macOS. Usage: pnpm icon
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "resources", "icon.svg"), "base64");
const png = join(root, "resources", "icon.png");
const icns = join(root, "build", "icon.icns");

app.dock?.hide();
// Not a top-level await: Electron fires `ready` only after the entry module has finished evaluating.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const page = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg}" width="1024" height="1024"></body></html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
  await new Promise((settle) => setTimeout(settle, 300));
  writeFileSync(png, (await window.webContents.capturePage()).resize({ width: 1024, height: 1024 }).toPNG());
  console.log(png);

  const iconset = join(mkdtempSync(join(tmpdir(), "icon-")), "icon.iconset");
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", ["-z", String(size * scale), String(size * scale), png, "--out", join(iconset, name)], { stdio: "ignore" });
    }
  }
  mkdirSync(dirname(icns), { recursive: true });
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
  rmSync(dirname(iconset), { recursive: true });
  console.log(icns);
  app.quit();
});
