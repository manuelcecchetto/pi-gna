// Mermaid fences drawn with Pele (docs/DESIGN.md, Diagrams). `markdown.ts` wraps a closed ```mermaid fence's code block in
// `<div class="diagram" data-diagram>`; `hydrateDiagrams` mounts a Pele diagram over it. Pele and each diagram type load
// on first use (`pele/lazy`), so a chat without diagrams never fetches them. Model output is untrusted: Pele escapes
// labels and drops scripts and `click` callbacks, links and images are off, and every SVG still goes through DOMPurify's
// SVG profile before it is inserted. A diagram Pele cannot draw stays the code block, with the reason above it.
import DOMPurify from "dompurify";
import type { Mounted } from "pele/lazy";

type Pele = typeof import("pele/lazy");
let pele: Promise<Pele> | undefined;
const loadPele = (): Promise<Pele> => (pele ??= import("pele/lazy"));

let purifier: ReturnType<typeof DOMPurify> | undefined;
function sanitizeSvg(svg: string): Node {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true });
}

// The diagrams mounted in each Markdown root, by their placeholder.
const mountedIn = new WeakMap<HTMLElement, Map<HTMLElement, Mounted | undefined>>();

/** Draws the diagram placeholders in `root` that are not drawn yet, and lets go of those no longer in it. */
export function hydrateDiagrams(root: HTMLElement | null): void {
  if (!root) return;
  let mounted = mountedIn.get(root);
  if (mounted) {
    for (const [el, diagram] of mounted) {
      if (root.contains(el)) continue;
      diagram?.destroy();
      mounted.delete(el);
    }
  }
  const pending = root.querySelectorAll<HTMLElement>(".diagram[data-diagram]:not([data-drawn])");
  if (!pending.length) return;
  if (!mounted) mountedIn.set(root, (mounted = new Map()));
  for (const el of pending) {
    el.dataset.drawn = "";
    mounted.set(el, undefined);
    void draw(el).then((diagram) => {
      if (!diagram) return;
      if (mounted.has(el) && root.contains(el)) mounted.set(el, diagram);
      else diagram.destroy();
    });
  }
}

/** Stops every diagram in `root` from following its width (the Markdown element is going away). */
export function releaseDiagrams(root: HTMLElement | null): void {
  const mounted = root && mountedIn.get(root);
  if (!mounted) return;
  for (const diagram of mounted.values()) diagram?.destroy();
  mounted.clear();
}

async function draw(el: HTMLElement): Promise<Mounted | undefined> {
  const code = el.querySelector(".code-block");
  const source = code?.querySelector("code")?.textContent ?? "";
  if (!code || !source.trim()) return undefined;
  let lib: Pele;
  try {
    lib = await loadPele();
  } catch {
    return undefined; // Left as the code block.
  }
  if (!el.isConnected) return undefined;
  const view = document.createElement("div");
  view.className = "diagram-view";
  el.prepend(view);
  const fontSize = Number.parseFloat(getComputedStyle(el).fontSize) || 14;
  let diagram: Mounted | undefined;
  try {
    diagram = await lib.mountAsync(view, source, { sanitize: sanitizeSvg, links: false, images: false, fontSize, padding: 4 });
  } catch (error) {
    return fail(el, view, error);
  }
  if (!diagram.result) {
    diagram.destroy();
    return fail(el, view, diagram.error);
  }
  code.setAttribute("hidden", "");
  el.append(actions(code));
  return diagram;
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
