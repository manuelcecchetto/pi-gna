import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { vendorChunk } from "./vite.chunks";

// One id per build, stamped into main and the preload. A running pi-gna loads main once, but a reload reads the
// preload and renderer from out/ again: after a `pnpm build` the window can be newer than main (StudioApi.stale).
const BUILD = { __PIGNA_BUILD__: JSON.stringify(process.env.PIGNA_BUILD ?? Date.now().toString(36)) };

// transcribe-cpp reads its version from its own package.json at runtime, which a bundle does not have: write it in
// at build time. A binding update that changes this code fails the build here instead of the worker at its start.
const TRANSCRIBE_VERSION = JSON.parse(readFileSync(resolve(import.meta.dirname, "node_modules/transcribe-cpp/package.json"), "utf8")).version as string;
const transcribeVersion = {
  name: "transcribe-cpp-version",
  transform(code: string, id: string) {
    if (!id.replaceAll("\\", "/").endsWith("/transcribe-cpp/dist/version.js")) return undefined;
    const call = "baseVersion(readPackageVersion())";
    if (!code.includes(call)) throw new Error(`transcribe-cpp ${TRANSCRIBE_VERSION}: version.js no longer reads its version as expected`);
    return code.replace(call, `baseVersion(${JSON.stringify(TRANSCRIBE_VERSION)})`);
  },
};

export default defineConfig({
  main: {
    define: BUILD,
    plugins: [transcribeVersion],
    // The usage index runs its extraction in a worker_thread, and dictation its model in a utility process: each needs
    // its own bundle next to index.js.
    build: { rollupOptions: { input: { index: "src/main/index.ts", "usage-worker": "src/main/usage-worker.ts", "dictation-worker": "src/main/dictation-worker.ts" } } },
    // transcribe-cpp (bundled into dictation-worker) loads the Koffi addon dictation downloads, not node_modules'.
    resolve: { alias: { koffi: resolve(import.meta.dirname, "src/main/dictation/koffi.ts") } },
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
