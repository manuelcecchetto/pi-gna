// Pure helpers for the rendered Markdown view: front matter, heading anchors and link/image classification.
// Everything here works on strings and URLs so it can be tested without a DOM.

export interface FrontMatter {
  /** Top-level `key: value` pairs, in file order. */
  entries: [string, string][];
  body: string;
}

/** Split a leading `---` YAML block off. Only flat scalars become entries; nested YAML is shown as its raw lines. */
export function splitFrontMatter(text: string): FrontMatter {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { entries: [], body: text };
  const entries: [string, string][] = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-][\w .-]*?):[ \t]*(.*)$/.exec(line);
    if (pair) entries.push([pair[1] as string, (pair[2] as string).replace(/^(["'])(.*)\1$/, "$2")]);
    else if (line.trim() && entries.length) entries[entries.length - 1] = [entries[entries.length - 1]![0], `${entries[entries.length - 1]![1]} ${line.trim()}`.trim()];
  }
  return { entries, body: text.slice(match[0].length) };
}

/** GitHub-style heading slug, unique within `seen`. */
export function slugify(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

export type LinkTarget =
  | { type: "anchor"; id: string }
  | { type: "local"; url: string }
  | { type: "web"; url: string }
  | { type: "mail"; url: string }
  | { type: "drop" };

/** What a link in a document at `base` (the viewer's own URL) should do. */
export function classifyLink(href: string, base: string): LinkTarget {
  if (href.startsWith("#")) return { type: "anchor", id: decodeURIComponent(href.slice(1)) };
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { type: "drop" };
  }
  const origin = new URL(base);
  if (url.protocol === "http:" || url.protocol === "https:") return { type: "web", url: url.href };
  if (url.protocol === "mailto:") return { type: "mail", url: url.href };
  if (url.protocol === origin.protocol && url.host === origin.host) {
    // A link to the document itself with a fragment is an anchor.
    if (url.pathname === origin.pathname && url.hash) return { type: "anchor", id: decodeURIComponent(url.hash.slice(1)) };
    url.search = "";
    return { type: "local", url: url.href };
  }
  return { type: "drop" };
}

/**
 * Where an image's bytes come from. Same-origin files need `?raw=1` (a plain navigation URL returns the viewer page),
 * `data:` images stay, remote images are not loaded (CSP) and report `remote`.
 */
export function resolveImage(src: string, base: string): { type: "local" | "data"; url: string } | { type: "remote" | "drop" } {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return { type: "drop" };
  }
  const origin = new URL(base);
  if (url.protocol === "data:") return /^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(src) ? { type: "data", url: src } : { type: "drop" };
  if (url.protocol === "http:" || url.protocol === "https:") return { type: "remote" };
  if (url.protocol === origin.protocol && url.host === origin.host) {
    url.search = "?raw=1";
    url.hash = "";
    return { type: "local", url: url.href };
  }
  return { type: "drop" };
}
