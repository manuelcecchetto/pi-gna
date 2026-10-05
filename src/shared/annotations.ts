// Browser comments as a prompt block, shared by the desktop (which composes its own prompt) and the host (which composes a
// phone's `chat.send`). Element crops travel as images in the same order. No Electron or DOM imports.
import type { Annotation } from "./browser";

/** Empty when there are none. */
export function formatAnnotations(annotations: Annotation[]): string {
  if (!annotations.length) return "";
  const items = annotations.map((a, index) =>
    [
      `${index + 1}. ${a.comment}`,
      `   page: ${a.url}${a.title ? ` (${a.title})` : ""}`,
      `   element: ${a.label}  selector: ${a.selector}`,
      `   html: ${a.html.replace(/\s+/g, " ").slice(0, 400)}`,
    ].join("\n"),
  );
  const note = annotations.some((a) => a.image) ? " Attached images are crops of the commented elements, in order." : "";
  return `<browser-comments>\nThe user commented on elements in the pi-gna browser.${note}\n${items.join("\n")}\n</browser-comments>`;
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
    return { id: text(a.id, 80), url: text(a.url, 2000), title: text(a.title, 300), selector: text(a.selector, 1000), label: text(a.label, 300), html: text(a.html, 4000), comment: text(a.comment, 4000), ...(image ? { image } : {}) };
  });
}
