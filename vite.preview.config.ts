import { cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// The file-preview viewer (src/preview): served by main under pigna-file://<token>/__viewer/. docs/FILE_PREVIEW.md.
const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, "out/preview");

/** pdf.js fetches CMaps, standard fonts, ICC profiles and decoders at run time; ship them as `pdfjs/<dir>/` (see src/preview/pdf.ts). */
function pdfjsData(): Plugin {
  const pdfjs = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  return {
    name: "pigna-pdfjs-data",
    writeBundle() {
      for (const dir of ["cmaps", "standard_fonts", "iccs"]) cpSync(resolve(pdfjs, dir), resolve(outDir, "pdfjs", dir), { recursive: true });
      // Decoders only: quickjs is pdf.js scripting, which the viewer never enables.
      cpSync(resolve(pdfjs, "wasm"), resolve(outDir, "pdfjs/wasm"), { recursive: true, filter: (path) => !/quickjs/.test(path) });
    },
  };
}

export default defineConfig({
  root: resolve(root, "src/preview"),
  base: "./",
  plugins: [pdfjsData()],
  build: { outDir, emptyOutDir: true, minify: true },
});
