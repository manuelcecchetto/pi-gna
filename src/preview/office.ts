// Shared by the DOCX, PPTX and XLSX views (BetterOffice canvas engines): the size and container checks before the whole
// file is read, the loading state, and the bundled font faces that stand in for Office fonts. Design: docs/FILE_PREVIEW.md.
import {
  loadBundledFontBytes,
  registerBundledFontFace,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  type BundledFontFace,
} from "@betteroffice/fonts";
import { PREVIEW_LIMITS } from "../shared/preview";
import { formatBytes } from "./format";
import { app, readBytes, showMessage, type Bytes, type Source } from "./shell";

/** What the first bytes say: a zip (a real OOXML file), an OLE container (legacy binary or encrypted), or neither. */
export function container(data: Uint8Array): "zip" | "ole" | "unknown" {
  if (data[0] === 0x50 && data[1] === 0x4b) return "zip";
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return "ole";
  return "unknown";
}

const NOUN = { docx: "document", pptx: "presentation", xlsx: "workbook" } as const;

/**
 * The whole file when it can be opened, or undefined after showing why not (empty, over the limit, legacy or
 * password-protected, not OOXML).
 */
export async function readOffice(source: Source, format: keyof typeof NOUN): Promise<Bytes | undefined> {
  const noun = NOUN[format];
  const head = await readBytes(source.rawUrl, 8);
  if (head.total === 0) return void showMessage(`This ${noun} is empty`, source.name);
  if (head.total > PREVIEW_LIMITS.office) {
    return void showMessage(`This ${noun} is too large to preview`, `${formatBytes(head.total)} is over the ${formatBytes(PREVIEW_LIMITS.office)} limit. Use Open with default app in the toolbar.`);
  }
  const kind = container(head.data);
  if (kind === "ole") {
    return void showMessage(`Can't preview this ${noun}`, "It is a legacy Office file or password-protected. Use Open with default app in the toolbar.");
  }
  if (kind === "unknown") return void showMessage("Can't show this file", `It is not a valid .${format} file (it may be corrupt).`, "error");
  showLoading(`Opening ${noun}…`, source.name);
  return readBytes(source.rawUrl, PREVIEW_LIMITS.office);
}

export function cantRead(noun: string): void {
  showMessage("Can't show this file", `The ${noun} could not be read. It may be corrupt, or password-protected.`, "error");
}

/** The full-page loading state with a spinner (opening a large document takes a moment). */
export function showLoading(title: string, detail: string): void {
  showMessage(title, detail);
  app.querySelector(".message")?.prepend(spinner());
}

export function spinner(): HTMLElement {
  const el = document.createElement("div");
  el.className = "spinner";
  return el;
}

/** Visually hidden text the agent's page snapshot and screen readers read in place of the canvas. */
export function textLayer(label: string, text: string): HTMLElement {
  const el = document.createElement("pre");
  el.className = "sr-only";
  el.setAttribute("aria-label", label);
  // The exports mark anchors with HTML comments; they mean nothing to a reader.
  el.textContent = text.replace(/<!--[\s\S]*?-->\n?/g, "");
  return el;
}

/** The bundled face drawn for an Office family: the family itself, its metric-compatible stand-in, else a last resort. */
export function faceFor(family: string, bold: boolean, italic: boolean): BundledFontFace {
  return resolveBundledFamilyFace(family, bold, italic) ?? resolveMetricCompatFace(family, bold, italic) ?? resolveLastResortFace(family, bold, italic);
}

export interface LoadedFace {
  family: string;
  bold: boolean;
  italic: boolean;
  bytes: Uint8Array;
}

const STYLES = [
  [false, false],
  [true, false],
  [false, true],
] as const;

/**
 * Regular, bold and italic of each family: their bytes (for engines that measure text in wasm), and the same faces
 * registered with the page under the file's own family names, since the canvas paints with `fillText` in that family.
 */
export async function loadFaces(families: Iterable<string>, withBytes = true): Promise<LoadedFace[]> {
  const bytes = new Map<string, Promise<Uint8Array>>();
  const jobs: Promise<LoadedFace | undefined>[] = [];
  for (const family of families) {
    for (const [bold, italic] of STYLES) {
      const face = faceFor(family, bold, italic);
      const registered = registerBundledFontFace(face, family).catch(() => undefined);
      if (!withBytes) {
        jobs.push(registered.then(() => undefined));
        continue;
      }
      if (!bytes.has(face.file)) bytes.set(face.file, loadBundledFontBytes(face).then((buffer) => new Uint8Array(buffer)));
      jobs.push(Promise.all([bytes.get(face.file)!, registered]).then(([data]) => ({ family, bold, italic, bytes: data })));
    }
  }
  return (await Promise.all(jobs)).filter((face): face is LoadedFace => !!face);
}
