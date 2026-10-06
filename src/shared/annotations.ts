// Browser comments as a prompt block, shared by the desktop (which composes its own prompt) and the host (which composes a
// phone's `chat.send`). Element crops travel as images in the same order. No Electron or DOM imports.
import type { Annotation } from "./browser";

/** Empty when there are none. */
export function formatAnnotations(annotations: Annotation[]): string {
  if (!annotations.length) return "";
  const items = annotations.map((a, index) =>
    [
      `${index + 1}. ${a.comment}`,
      a.file ? `   file: ${a.file}${a.line ? `:${a.line}` : ""}` : `   page: ${a.url}${a.title ? ` (${a.title})` : ""}`,
      `   element: ${a.label}  selector: ${a.selector}`,
      a.box && `   box: ${a.box}${a.viewport ? ` in a ${a.viewport} viewport` : ""}`,
      a.styles && `   styles: ${a.styles}`,
      `   html: ${a.html.replace(/\s+/g, " ").slice(0, 400)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const notes = [
    annotations.some((a) => a.line) && "A file line is where the element, or the Markdown block holding it, starts.",
    annotations.some((a) => a.image) && "Attached images are crops of the commented elements, in order.",
  ].filter(Boolean);
  return `<browser-comments>\nThe user commented on elements in the pi-gna browser or a file preview.${notes.map((n) => ` ${n}`).join("")}\n${items.join("\n")}\n</browser-comments>`;
}

export const MAX_ANNOTATIONS = 20;
const MAX_IMAGE_CHARS = 3_000_000;
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/** What a client sent as annotations -> clean ones (strings capped, oversized crops dropped); throws on a wrong shape. */
export function parseAnnotations(raw: unknown): Annotation[] {
  if (!Array.isArray(raw) || raw.length > MAX_ANNOTATIONS) throw new Error(`annotations must be a list of at most ${MAX_ANNOTATIONS}`);
  return raw.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("invalid annotation");
    const a = item as Record<string, unknown>;
    const image = typeof a.image === "string" && a.image.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/.test(a.image) ? a.image : undefined;
    const line = typeof a.line === "number" && Number.isInteger(a.line) && a.line > 0 ? a.line : undefined;
    const extra = { file: text(a.file, 2000), box: text(a.box, 80), viewport: text(a.viewport, 40), styles: text(a.styles, 600) };
    return {
      id: text(a.id, 80),
      url: text(a.url, 2000),
      title: text(a.title, 300),
      selector: text(a.selector, 1000),
      label: text(a.label, 300),
      html: text(a.html, 4000),
      comment: text(a.comment, 4000),
      ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value)),
      ...(line ? { line } : {}),
      ...(image ? { image } : {}),
    };
  });
}
