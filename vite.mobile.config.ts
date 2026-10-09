import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { serviceWorkerSource, shellFiles } from "./src/mobile/service-worker";

// Same id as main (scripts/build.mjs sets PIGNA_BUILD for both builds).
const BUILD = process.env.PIGNA_BUILD ?? Date.now().toString(36);
const root = dirname(fileURLToPath(import.meta.url));
const SHELL_STATIC = ["/manifest.webmanifest", "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png"];

// sw.js is generated so it can embed the build id and the exact list of hashed shell files.
function serviceWorker(): Plugin {
  return {
    name: "pigna-sw",
    generateBundle(_options, bundle) {
      const shell = ["/", ...SHELL_STATIC, ...shellFiles(bundle).map((name) => `/${name}`)];
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource(BUILD, shell) });
    },
  };
}

export default defineConfig({
  root: resolve(root, "src/mobile"),
  publicDir: resolve(root, "src/mobile/public"),
  define: { __PIGNA_BUILD__: JSON.stringify(BUILD) },
  plugins: [react(), tailwindcss(), serviceWorker()],
  build: { outDir: resolve(root, "out/mobile"), emptyOutDir: true, minify: true },
});
