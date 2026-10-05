// PPTX view: BetterOffice's presentation engine lays each slide out in wasm and paints it on its own canvas, scaled to
// the pane width. Slides are laid out and painted as they come near the viewport, so a long deck opens as fast as a
// short one. The deck's text is kept as hidden Markdown for the agent's page snapshot. Design: docs/FILE_PREVIEW.md.
import { exportPptxMarkdown, initWasm, inspectPresentation, openPresentation, paintSlide, sizeCanvasForSlide, type PresentationHandle, type SlideDisplayList } from "@betteroffice/pptx";
import { formatBytes } from "./format";
import { cantRead, loadFaces, readOffice, textLayer } from "./office";
import { app, showMessage, type Source } from "./shell";

const MAX_WIDTH = 1280;

/** Font families the deck names (theme and explicit runs); `+mj-lt`-style theme references are resolved by the engine. */
function deckFamilies(inspection: unknown): Set<string> {
  const json = JSON.stringify(inspection);
  const families = new Set([...json.matchAll(/"(?:latin|typeface|font\w*)"\s*:\s*"([^"+][^"]*)"/gi)].map((match) => match[1]!));
  if (!families.size) families.add("Calibri");
  return families;
}

export async function showPptx(source: Source): Promise<void> {
  const [file] = await Promise.all([readOffice(source, "pptx"), initWasm()]);
  if (!file) return;
  let deck: PresentationHandle;
  try {
    // Without registered faces the engine cannot measure slide text, and the canvas would paint it in a default serif.
    const faces = await loadFaces(deckFamilies(inspectPresentation(file.data)));
    deck = openPresentation(file.data, { fonts: faces });
  } catch {
    return cantRead("presentation");
  }
  const snapshot = deck.snapshot();
  const count = snapshot.slides.length;
  if (!count) return showMessage("This presentation has no slides", source.name);

  const stage = document.createElement("div");
  stage.className = "office-stage pptx-stage";
  stage.tabIndex = 0;
  const list = document.createElement("div");
  list.className = "pptx-slides";
  list.style.setProperty("--ratio", `${snapshot.widthEmu} / ${snapshot.heightEmu}`);
  stage.append(list);
  const bar = document.createElement("div");
  bar.className = "footer";
  const info = document.createElement("span");
  info.textContent = `${count} ${count === 1 ? "slide" : "slides"} · ${formatBytes(file.total)}`;
  bar.append(info);

  const frames: (SlideDisplayList | undefined)[] = [];
  const painted = new Map<number, number>();
  const canvases = snapshot.slides.map((slide, index) => {
    const canvas = document.createElement("canvas");
    canvas.className = "pptx-slide";
    canvas.dataset.slide = String(index + 1);
    canvas.title = slide.name ?? `Slide ${index + 1}`;
    list.append(canvas);
    return canvas;
  });
  const width = (): number => Math.max(160, Math.min(MAX_WIDTH, stage.clientWidth - 48));

  /** Lay out (once) and paint one slide at the current width; a failed slide stays a blank page. */
  const paint = async (index: number): Promise<void> => {
    const target = width();
    if (painted.get(index) === target) return;
    painted.set(index, target);
    try {
      const frame = (frames[index] ??= deck.layoutSlide(index));
      const canvas = canvases[index]!;
      const scale = target / frame.width;
      sizeCanvasForSlide(canvas, frame, devicePixelRatio, scale);
      await paintSlide(canvas.getContext("2d")!, frame, devicePixelRatio, scale);
      canvas.classList.add("painted");
      if (index === 0) performance.mark("preview:first-page");
    } catch (error) {
      console.warn("[pptx] slide", index + 1, error);
    }
  };
  const visible = new Set<number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.slide) - 1;
        if (entry.isIntersecting) {
          visible.add(index);
          void paint(index);
        } else visible.delete(index);
      }
    },
    { root: stage, rootMargin: "100% 0px" },
  );
  for (const canvas of canvases) observer.observe(canvas);
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    list.style.setProperty("--slide-width", `${width()}px`);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => visible.forEach((index) => void paint(index)), 120);
  }).observe(stage);

  app.replaceChildren(stage, bar);
  list.style.setProperty("--slide-width", `${width()}px`);
  stage.focus({ preventScroll: true });
  void exportPptxMarkdown(file.data, { includeNotes: true })
    .then((content) => app.append(textLayer("Slide text", content.markdown)))
    .catch(() => undefined);
}
