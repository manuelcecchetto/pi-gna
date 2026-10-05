import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The file-preview viewer (src/preview): served by main under pigna-file://<token>/__viewer/. docs/FILE_PREVIEW.md.
// React is only for the DOCX view (BetterOffice's DocxEditor); its resident layout worker is an ES module worker.
const root = dirname(fileURLToPath(import.meta.url));

/**
 * BetterOffice docx-react 0.4.3 gives a document that painted its first-page preview 10 s to finish opening, then
 * replaces the view with "Failed to Load Document". A 150-page contract takes 7-9 s on an idle machine, so a busy one
 * fails it; the limit is not a prop. Raise it to 2 minutes. Remove once the editor takes `fullOpenTimeoutMs` from its
 * props; the build fails here if the code it rewrites changes.
 */
function docxOpenTimeout(): Plugin {
  const from = "fullOpenTimeoutMs??kf";
  return {
    name: "pigna-docx-open-timeout",
    transform(code, id) {
      if (!id.includes("@betteroffice/docx-react/dist/index.mjs")) return undefined;
      if (code.split(from).length !== 2) throw new Error(`docx-react changed: expected one "${from}" to raise the open timeout`);
      return { code: code.replace(from, "fullOpenTimeoutMs??12e4"), map: null };
    },
  };
}

export default defineConfig({
  root: resolve(root, "src/preview"),
  base: "./",
  plugins: [react(), docxOpenTimeout()],
  worker: { format: "es" },
  build: { outDir: resolve(root, "out/preview"), emptyOutDir: true, minify: true, target: "esnext", chunkSizeWarningLimit: 4096 },
});
