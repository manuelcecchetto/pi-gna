import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// One id per build, stamped into main and the preload. A running pi-gna loads main once, but a reload reads the
// preload and renderer from out/ again: after a `pnpm build` the window can be newer than main (StudioApi.stale).
const BUILD = { __PIGNA_BUILD__: JSON.stringify(Date.now().toString(36)) };

export default defineConfig({
  main: { define: BUILD },
  preload: {
    define: BUILD,
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: { minify: true },
  },
});
