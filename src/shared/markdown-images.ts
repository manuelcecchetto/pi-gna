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
    if (token.type !== "html") return;
    for (const [, body] of token.text.matchAll(IMG_TAG)) {
      const src = imgAttributes(body!).src ?? "";
      if (isLocalLinkHref(src)) targets.push(src);
    }
  });
  return targets;
}
