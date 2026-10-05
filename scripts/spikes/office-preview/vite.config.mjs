import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
const pages = ["bo-docx", "bo-pptx", "bo-xlsx", "dp-docx", "ts-xlsx", "wn-parse", "wn-docx"];
export default defineConfig({
  root: "web", base: "./", plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, target: "esnext", assetsInlineLimit: 0, chunkSizeWarningLimit: 100000,
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve("web", p + ".html")])) } },
  worker: { format: "es" },
});
