import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The file-preview viewer (src/preview): served by main under pigna-file://<token>/__viewer/. docs/FILE_PREVIEW.md.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, "src/preview"),
  base: "./",
  build: { outDir: resolve(root, "out/preview"), emptyOutDir: true, minify: true },
});
