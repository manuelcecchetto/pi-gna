// `pnpm build`: the desktop bundles (electron-vite), the mobile bundle (out/mobile) and the file-preview viewer (out/preview), stamped with one build id so
// the phone's /api/hello comparison against main's id is meaningful.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, PIGNA_BUILD: process.env.PIGNA_BUILD ?? Date.now().toString(36) };
for (const args of [["electron-vite", "build"], ["vite", "build", "-c", "vite.mobile.config.ts"], ["vite", "build", "-c", "vite.preview.config.ts"]]) {
  // pnpm is a .cmd on Windows, which only starts through a shell (the arguments here are fixed).
  const run = spawnSync("pnpm", ["exec", ...args], { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
