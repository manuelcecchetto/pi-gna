import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { vendorChunk } from "./vite.chunks";

// One id per build, stamped into main and the preload. A running pi-gna loads main once, but a reload reads the
// preload and renderer from out/ again: after a `pnpm build` the window can be newer than main (StudioApi.stale).
const BUILD = { __PIGNA_BUILD__: JSON.stringify(process.env.PIGNA_BUILD ?? Date.now().toString(36)) };

export default defineConfig({
  main: {
    define: BUILD,
    // The usage index runs its extraction in a worker_thread, which needs its own bundle next to index.js.
    build: { rollupOptions: { input: { index: "src/main/index.ts", "usage-worker": "src/main/usage-worker.ts" } } },
  },
  preload: {
    define: BUILD,
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Electron 44's Chromium (electron-vite's own table stops at Electron 39); vite.chunks.test.ts keeps it in step.
    build: { minify: true, target: "chrome152", rollupOptions: { output: { manualChunks: vendorChunk } } },
  },
});
