// Mermaid fences drawn with Pele (docs/DESIGN.md, Diagrams). `markdown.ts` wraps a closed ```mermaid fence's code block in
// `<div class="diagram" data-diagram>`; `hydrateDiagrams` mounts a Pele diagram over it. Pele and each diagram type load
// on first use (`pele/lazy`), so a chat without diagrams never fetches them. Model output is untrusted: Pele escapes
// labels and drops scripts and `click` callbacks, links and images are off, and every SVG still goes through DOMPurify's
// SVG profile before it is inserted. A diagram Pele cannot draw stays the code block, with the reason above it.
import DOMPurify from "dompurify";
import type { Mounted, RenderOptions } from "pele/lazy";

type Pele = typeof import("pele/lazy");
let pele: Promise<Pele> | undefined;
const loadPele = (): Promise<Pele> => (pele ??= import("pele/lazy"));

let purifier: ReturnType<typeof DOMPurify> | undefined;
function sanitizeSvg(svg: string): Node {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true });
}

/** The smallest a diagram is shown at: below it, labels drawn at the prose's size get too small to read. */
const MIN_SCALE = 0.75;
/** A `directionBreakpoint` every width is under: diagrams that support it lay out top to bottom. */
const VERTICAL = 1e9;

// What lets go of each diagram mounted in a Markdown root, by its placeholder.
const mountedIn = new WeakMap<HTMLElement, Map<HTMLElement, (() => void) | undefined>>();

/** Draws the diagram placeholders in `root` that are not drawn yet, and lets go of those no longer in it. */
export function hydrateDiagrams(root: HTMLElement | null): void {
  if (!root) return;
  let mounted = mountedIn.get(root);
  if (mounted) {
    for (const [el, release] of mounted) {
      if (root.contains(el)) continue;
      release?.();
      mounted.delete(el);
    }
  }
  const pending = root.querySelectorAll<HTMLElement>(".diagram[data-diagram]:not([data-drawn])");
  if (!pending.length) return;
  if (!mounted) mountedIn.set(root, (mounted = new Map()));
  for (const el of pending) {
    el.dataset.drawn = "";
    mounted.set(el, undefined);
    void draw(el).then((release) => {
      if (!release) return;
      if (mounted.has(el) && root.contains(el)) mounted.set(el, release);
      else release();
    });
  }
}

/** Stops every diagram in `root` from following its width (the Markdown element is going away). */
export function releaseDiagrams(root: HTMLElement | null): void {
  const mounted = root && mountedIn.get(root);
  if (!mounted) return;
  for (const release of mounted.values()) release?.();
  mounted.clear();
}

/**
 * Options that show `source` readably at `width`. Pele shrinks a diagram that does not fit, which turned a wide state
 * machine with sentence labels into 4 px text: as written while it shows at MIN_SCALE or larger, else top to bottom when
 * that is larger, else at its natural size (whichever layout is wider still) in a box that scrolls sideways.
 */
function layoutFor(lib: Pele, source: string, base: RenderOptions, width: number): RenderOptions {
  const scale = (options: RenderOptions) => {
    try {
      return Math.min(1, width / lib.render(source, { ...base, ...options, maxWidth: width }).width);
    } catch {
      return 0;
    }
  };
  const asWritten = scale({});
  if (asWritten >= MIN_SCALE) return base;
  const vertical = scale({ directionBreakpoint: VERTICAL });
  const options = vertical > asWritten ? { ...base, directionBreakpoint: VERTICAL } : base;
  return Math.max(asWritten, vertical) >= MIN_SCALE ? options : { ...options, responsive: false };
}

const sameLayout = (a: RenderOptions, b: RenderOptions) => a.directionBreakpoint === b.directionBreakpoint && a.responsive === b.responsive;

async function draw(el: HTMLElement): Promise<(() => void) | undefined> {
  const code = el.querySelector(".code-block");
  const source = code?.querySelector("code")?.textContent ?? "";
  if (!code || !source.trim()) return undefined;
  let lib: Pele;
  try {
    lib = await loadPele();
  } catch {
    return undefined; // Left as the code block.
  }
  // An unknown type fails in `mount` below, which says so.
  await lib.load(lib.detectType(source)).catch(() => false);
  if (!el.isConnected) return undefined;
  const view = document.createElement("div");
  view.className = "diagram-view";
  el.prepend(view);
  const fontSize = Number.parseFloat(getComputedStyle(el).fontSize) || 14;
  const base: RenderOptions = { links: false, images: false, fontSize, padding: 4 };
  let layout = layoutFor(lib, source, base, el.clientWidth);
  const mountOptions = (options: RenderOptions) => ({ ...options, sanitize: sanitizeSvg, zoom: options.responsive === false ? false : ("auto" as const) });
  view.classList.toggle("scroll", layout.responsive === false);
  let diagram: Mounted;
  try {
    diagram = lib.mount(view, source, mountOptions(layout));
  } catch (error) {
    return fail(el, view, error);
  }
  if (!diagram.result) {
    diagram.destroy();
    return fail(el, view, diagram.error);
  }
  code.setAttribute("hidden", "");
  el.append(actions(code));
  // Pele follows the width with the options it has; a width that calls for another layout swaps them.
  let width = el.clientWidth;
  const resized = new ResizeObserver(() => {
    if (el.clientWidth === width || !el.clientWidth) return;
    width = el.clientWidth;
    const next = layoutFor(lib, source, base, width);
    if (sameLayout(next, layout)) return;
    layout = next;
    view.classList.toggle("scroll", layout.responsive === false);
    diagram.update(source, mountOptions(layout));
  });
  resized.observe(el);
  return () => {
    resized.disconnect();
    diagram.destroy();
  };
}

function fail(el: HTMLElement, view: HTMLElement, error: unknown): undefined {
  view.remove();
  const note = document.createElement("p");
  note.className = "diagram-note";
  // Pele's messages quote the diagram source: text only. A parse error spans lines (where, the source line, a caret and
  // what was expected); the first line and the expectation say it.
  const lines = error instanceof Error ? error.message.split("\n") : [];
  const expected = lines.slice(1).find((line) => line.startsWith("Expecting"));
  const reason = [lines[0], expected].filter(Boolean).join(" ") || "unsupported diagram";
  note.textContent = `Diagram could not be drawn: ${reason}`;
  el.prepend(note);
  return undefined;
}

/** Under the diagram, shown on hover like a visual's: the Mermaid source (whose header has Copy) on demand. */
function actions(code: Element): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "diagram-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Source";
  button.addEventListener("click", () => {
    const show = code.hasAttribute("hidden");
    code.toggleAttribute("hidden", !show);
    button.textContent = show ? "Hide source" : "Source";
  });
  footer.append(button);
  return footer;
}
