import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The file-preview viewer (src/preview): served by main under pigna-file://<token>/__viewer/. docs/FILE_PREVIEW.md.
// React is only for the DOCX view (BetterOffice's DocxEditor); its resident layout worker is an ES module worker.
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

/** A build-time rewrite of a dependency's code: `from` must occur exactly once, so the build fails when that code changes. */
export interface Rewrite {
  why: string;
  from: string;
  to: string;
}

/**
 * BetterOffice docx-react 0.4.3 (pinned). Remove a rewrite once the editor offers it as a prop.
 * - It gives a document that painted its first-page preview 10 s to finish opening, then replaces the view with "Failed
 *   to Load Document". A 150-page contract takes 7-9 s on an idle machine, so a busy one fails it. Raise it to 2 minutes.
 * - Each page near the viewport gets an invisible DOM copy, one positioned element per glyph (the accessibility mirror):
 *   a 44-page contract held 237k DOM nodes after opening and about 1M after a scroll through it. The viewer's text
 *   layer already gives screen readers and the agent the whole text, so the copies are left empty.
 * - The canvas renderer reads `devicePixelRatio` when it paints but does not repaint when only that changes (the window
 *   moved to a display with another density), so pages stayed blurry or over-sampled until the zoom changed. Its paint
 *   effect also depends on the density (`useDensity`, src/preview/density.ts).
 */
export const DOCX_REACT: Rewrite[] = [
  { why: "the open timeout", from: "fullOpenTimeoutMs??kf", to: "fullOpenTimeoutMs??12e4" },
  {
    why: "the page mirror",
    from: "LA=(e,t)=>buildMirrorPage(e,A0(e,t)),MA=(e,t,n)=>n?reduceMirrorToText(n):buildMirrorPageText(e,A0(e,t))",
    to: "LA=()=>null,MA=()=>null",
  },
  { why: "the paint density", from: "},[e,t,n,a,l,st,M,k,c,i,Y,Qt,Lt,S])", to: "},[e,t,n,a,l,st,M,k,c,i,Y,Qt,Lt,S,__pignaDensity()])" },
];

export function rewrite(code: string, rewrites: Rewrite[], what: string): string {
  for (const { why, from, to } of rewrites) {
    if (code.split(from).length !== 2) throw new Error(`${what} changed: expected one "${from}" to rewrite ${why}`);
    code = code.replace(from, () => to);
  }
  return code;
}

function docxReact(): Plugin {
  const density = resolve(root, "src/preview/density.ts");
  return {
    name: "pigna-docx-react",
    transform(code, id) {
      if (!id.includes("@betteroffice/docx-react/dist/index.mjs")) return undefined;
      return { code: `import { useDensity as __pignaDensity } from ${JSON.stringify(density)};\n${rewrite(code, DOCX_REACT, "docx-react")}`, map: null };
    },
  };
}

const compress = promisify(brotliCompress);

/** Brotli at its best setting for fonts; the result is kept under `cache` by content hash, since the faces rarely change. */
export async function packFont(data: Buffer, cache: string): Promise<Buffer> {
  const file = join(cache, `${createHash("sha256").update(data).digest("hex")}.br`);
  try {
    return readFileSync(file);
  } catch {
    const packed = await compress(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
    });
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, packed);
    return packed;
  }
}

/** Every `.ttf` under `dir`, recursively. */
function fontsIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ttf"))
    .map((name) => join(dir, name));
}

/**
 * The Office faces (14 MB of TrueType) and pdf.js's standard fonts are stored as `<name>.ttf.br`, about 6 MB, and main
 * inflates them when the viewer asks for `<name>.ttf` (`serveViewer` in src/main/browser/preview-protocol.ts). Not WOFF2:
 * the engines' wasm (ttf-parser, rustybuzz) reads the same bytes the page registers, @betteroffice/fonts checks their
 * length, and neither Chromium nor Node decodes WOFF2 into TrueType, so the bytes must arrive as the original font.
 */
function packFonts(cache: string): Plugin {
  return {
    name: "pigna-pack-fonts",
    // After pdfjsData copied its fonts.
    writeBundle: {
      order: "post",
      sequential: true,
      async handler(options) {
        await Promise.all(
          fontsIn(options.dir ?? outDir).map(async (file) => {
            writeFileSync(`${file}.br`, await packFont(readFileSync(file), cache));
            rmSync(file);
          }),
        );
      },
    },
  };
}

export default defineConfig({
  root: resolve(root, "src/preview"),
  base: "./",
  plugins: [react(), docxReact(), pdfjsData(), packFonts(resolve(root, "node_modules/.cache/pigna-preview-fonts"))],
  worker: { format: "es" },
  build: {
    outDir,
    emptyOutDir: true,
    minify: true,
    target: "esnext",
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // The DOCX view (React, docx-react and the engine's JS) shares its chunk with the editor's dialogs, which never
        // load in a read-only view; Rollup named it after one of them.
        chunkFileNames: (chunk) => (chunk.moduleIds.some((id) => id.endsWith("/src/preview/docx.tsx")) ? "assets/docx-[hash].js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
