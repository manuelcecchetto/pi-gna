// Resize resources/icon.png into the PWA icons under src/mobile/public/icons (committed). sips ships with macOS.
// apple-touch-icon is opaque-friendly 180px; the manifest lists 192 and 512. Usage: pnpm icon:mobile
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "mobile", "public", "icons");
mkdirSync(out, { recursive: true });
for (const [name, size] of [["apple-touch-icon", 180], ["icon-192", 192], ["icon-512", 512]]) {
  const file = join(out, `${name}.png`);
  execFileSync("sips", ["-z", String(size), String(size), join(root, "resources", "icon.png"), "--out", file], { stdio: "ignore" });
  console.log(file);
}
