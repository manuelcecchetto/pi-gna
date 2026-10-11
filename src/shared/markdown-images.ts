// The local images a chat answer embeds (`![alt](target)`, raw `<img src="target">`), read the way the chat's markdown
// renders them as images (renderer/src/lib/markdown.ts). Main reads the same list so a phone can load the images a
// chat showed wherever they are (docs/FILE_PREVIEW.md, Phone).
import { Marked, type Token } from "marked";
import { isLocalLinkHref } from "./preview";

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" };
/** A raw `<img>` tag; group 1 is what follows `<img`. */
export const IMG_TAG = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A raw `<img>` tag's attributes from what follows `<img`: names lowercased, the common entities decoded. */
export function imgAttributes(body: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, name, double, single, bare] of body.matchAll(ATTRIBUTE)) {
    attributes[name!.toLowerCase()] = (double ?? single ?? bare ?? "").replace(/&(amp|quot|apos|lt|gt|#39);/g, (_, entity: string) => ENTITIES[entity]!);
  }
  return attributes;
}

const lexer = new Marked({ gfm: true });

/** The local image targets `markdown` embeds, in order, as written. Code (fenced or inline) embeds nothing. */
export function embeddedImageTargets(markdown: string): string[] {
  const targets: string[] = [];
  lexer.walkTokens(lexer.lexer(markdown), (token: Token) => {
    if (token.type === "image" && isLocalLinkHref(token.href)) targets.push(token.href);
    // An inline visual shows its local images too (the chat inlines them into the frame: visualImageTargets).
    if (token.type === "code" && token.lang === "visual") targets.push(...visualImageTargets(token.text));
    if (token.type !== "html") return;
    for (const [, body] of token.text.matchAll(IMG_TAG)) {
      const src = imgAttributes(body!).src ?? "";
      if (isLocalLinkHref(src)) targets.push(src);
    }
  });
  return targets;
}

/** An image tag of a visual: HTML `<img>` or SVG `<image>`; group 1 is the name, group 2 what follows it. */
const VISUAL_IMAGE_TAG = /<(img|image)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
/** The attribute holding an image tag's source. */
const sourceAttribute = (tag: string, name: string) => (tag.toLowerCase() === "img" ? name === "src" : name === "href" || name === "xlink:href");

/**
 * The local images a visual fragment shows, in order, as written: `<img src>` and SVG `<image href>` (or `xlink:href`).
 * The frame itself loads nothing (its CSP allows only data: and blob: images), so the chat reads these the way it reads
 * an answer's `![alt](path)` and inlines them (`inlineVisualImages`).
 */
export function visualImageTargets(html: string): string[] {
  const targets: string[] = [];
  for (const [, tag, body] of html.matchAll(VISUAL_IMAGE_TAG)) {
    for (const [name, value] of Object.entries(imgAttributes(body!))) if (sourceAttribute(tag!, name) && isLocalLinkHref(value)) targets.push(value);
  }
  return targets;
}

/** `html` with each image source found in `sources` (target as written -> data URL) replaced; the rest stays as written. */
export function inlineVisualImages(html: string, sources: ReadonlyMap<string, string>): string {
  if (!sources.size) return html;
  return html.replace(VISUAL_IMAGE_TAG, (whole, tag: string, body: string) => {
    const rewritten = body.replace(ATTRIBUTE, (attribute, name: string) => {
      if (!sourceAttribute(tag, name.toLowerCase())) return attribute;
      const url = sources.get(imgAttributes(attribute)[name.toLowerCase()] ?? "");
      return url ? `${name}="${url}"` : attribute;
    });
    return `<${tag}${rewritten}>`;
  });
}
