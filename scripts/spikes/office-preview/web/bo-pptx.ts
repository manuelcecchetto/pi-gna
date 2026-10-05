import { initWasm, inspectPresentation, openPresentation, paintSlide, sizeCanvasForSlide } from "@betteroffice/pptx";
import { loadBundledFontBytes, registerBundledFontFace, resolveBundledFamilyFace, resolveMetricCompatFace, resolveLastResortFace } from "@betteroffice/fonts";
import { done, fail, loadBytes, mark } from "./common";

(async () => {
  mark("script");
  const [bytes] = await Promise.all([loadBytes(), initWasm().then(() => mark("wasm"))]);
  // Font pass: the deck's font names (theme + explicit) from inspectPresentation, each mapped to a bundled face.
  const json = JSON.stringify(inspectPresentation(bytes));
  const fam = new Set([...json.matchAll(/"(?:latin|typeface|font\w*)"\s*:\s*"([^"+][^"]*)"/gi)].map((m) => m[1]));
  if (!fam.size) fam.add("Calibri");
  const faces: any[] = [];
  for (const f of fam) for (const [b, i] of [[false, false], [true, false], [false, true]] as const) {
    faces.push({ family: f, bold: b, italic: i, face: resolveBundledFamilyFace(f, b, i) ?? resolveMetricCompatFace(f, b, i) ?? resolveLastResortFace(f, b, i) });
  }
  let fontBytes = 0;
  const cache = new Map<string, Promise<Uint8Array>>();
  const fonts = await Promise.all(faces.map(async (x) => {
    if (!cache.has(x.face.file)) cache.set(x.face.file, loadBundledFontBytes(x.face).then((b) => { const u = new Uint8Array(b); fontBytes += u.byteLength; return u; }));
    return { family: x.family, bold: x.bold, italic: x.italic, bytes: await cache.get(x.face.file)! };
  }));
  // Canvas paints with fillText(fontFamily): the browser needs the same faces under the deck's family names.
  await Promise.all(faces.map((x) => registerBundledFontFace(x.face, x.family)));
  const deck = openPresentation(bytes, { fonts });
  mark("open");
  const n = deck.snapshot().slides.length;
  mark("fonts");
  const root = document.getElementById("root")!;
  root.className = "stack"; root.style.height = "auto";
  const dpr = devicePixelRatio;
  for (let i = 0; i < n; i++) {
    const frame = deck.layoutSlide(i);
    const c = document.createElement("canvas");
    const scale = 960 / frame.width;
    sizeCanvasForSlide(c, frame, dpr, scale);
    root.append(c);
    await paintSlide(c.getContext("2d")!, frame, dpr, scale);
    if (i === 0) { await new Promise(requestAnimationFrame); mark("firstPage"); }
  }
  done({ slides: n, families: [...fam], fontFiles: cache.size, fontBytes });
})().catch(fail);
