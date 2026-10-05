// File preview model shared by main, renderer, phone and the agent extension: kinds, modes, path parsing, URLs.
// Design and security model: docs/FILE_PREVIEW.md.

export type PreviewKind = "pdf" | "image" | "docx" | "pptx" | "xlsx" | "markdown" | "html" | "json" | "table" | "video" | "audio" | "code" | "text" | "other";

/** rendered = the kind's rich view; raw = the source text. */
export type PreviewMode = "rendered" | "raw";

/** Preview state of a browser tab; absent on web tabs. */
export interface TabPreview {
  /** Real absolute path of the file (the tab URL carries a token instead). */
  path: string;
  name: string;
  kind: PreviewKind;
  mode: PreviewMode;
  /** Modes the kind supports, default first. */
  modes: PreviewMode[];
}

/** Options of opening a file in a preview tab. */
export interface PreviewOpenOptions {
  /** Open another tab even if the file is already previewed. */
  newTab?: boolean;
  agent?: string;
  /** 1-based line to scroll to, for kinds that have lines. */
  line?: number;
  mode?: PreviewMode;
  /** Project directory; a file inside it is served from it so relative links between project files work. */
  root?: string;
}

/** Scheme served by main for previews; see docs/FILE_PREVIEW.md. */
export const PREVIEW_SCHEME = "pigna-file";

/** Size limits (bytes) enforced by the viewer; see docs/FILE_PREVIEW.md. */
export const PREVIEW_LIMITS = {
  text: 2_000_000,
  highlight: 512_000,
  highlightLines: 10_000,
  /** DOCX, PPTX and XLSX: the whole file is read into the viewer and opened by a wasm engine. */
  office: 25_000_000,
  tableRows: 5_000,
} as const;

const EXTENSIONS: Record<string, PreviewKind> = {};
function register(kind: PreviewKind, list: string): void {
  for (const ext of list.split(" ")) EXTENSIONS[ext] = kind;
}
register("pdf", "pdf");
register("image", "png jpg jpeg gif webp avif bmp ico svg");
register("docx", "docx");
register("pptx", "pptx");
register("xlsx", "xlsx");
register("markdown", "md markdown mdx");
register("html", "html htm xhtml");
register("json", "json jsonc");
register("table", "csv tsv");
register("video", "mp4 mov m4v webm");
register("audio", "mp3 m4a wav ogg flac aac opus");
register(
  "code",
  "ts tsx mts cts js jsx mjs cjs py rs go rb java kt swift c h cc cpp hpp css scss less sh zsh bash sql yml yaml toml xml graphql gql diff patch vue svelte php lua dart cs",
);
register("text", "txt log env ini conf cfg lock gitignore");

/** Shiki language ids by extension, matching the names in renderer/lib/highlight.ts. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", sh: "bash", zsh: "bash", bash: "bash",
  py: "python", rs: "rust", go: "go", swift: "swift", css: "css",
  html: "html", htm: "html", xhtml: "html", md: "markdown", markdown: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", diff: "diff", patch: "diff",
  java: "java", kt: "kotlin", rb: "ruby", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  xml: "xml", svg: "xml", graphql: "graphql", gql: "graphql",
};

/** File name of a path (either separator). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Lowercase extension without the dot; empty for no extension and for dotfiles like `.env`. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Kind by extension. Unknown or missing extensions are `other`; main sniffs those (text vs binary) and
 * upgrades to `text`. Well-known dotfiles and extensionless names are text.
 */
export function kindFor(path: string): PreviewKind {
  const name = baseName(path);
  if (name === "Dockerfile" || name === "Makefile") return "code";
  const ext = extensionOf(path);
  if (ext) return EXTENSIONS[ext] ?? "other";
  return /^\.(env|gitignore|npmrc|editorconfig|prettierrc|eslintrc)/.test(name) ? "text" : "other";
}

/** Shiki language id for syntax highlighting, when the file has one. */
export function languageFor(path: string): string | undefined {
  if (baseName(path) === "Dockerfile") return "dockerfile";
  return LANGUAGES[extensionOf(path)];
}

/** Modes a file supports, default first. */
export function modesFor(path: string, kind: PreviewKind = kindFor(path)): PreviewMode[] {
  switch (kind) {
    case "markdown":
    case "json":
    case "table":
    case "html":
      return ["rendered", "raw"];
    case "image":
      return extensionOf(path) === "svg" ? ["rendered", "raw"] : ["rendered"];
    case "code":
    case "text":
      return ["raw"];
    default:
      return ["rendered"];
  }
}

/** How a file in a given mode is delivered: bytes straight to Chromium (rendered HTML only), or through the bundled viewer page. */
export function servedAs(kind: PreviewKind, mode: PreviewMode): "raw" | "viewer" {
  return kind === "html" && mode === "rendered" ? "raw" : "viewer";
}

/** Preview state for a freshly opened file, in the kind's default mode. */
export function previewFor(path: string, kind: PreviewKind = kindFor(path)): TabPreview {
  const modes = modesFor(path, kind);
  return { path, name: baseName(path), kind, mode: modes[0] ?? "rendered", modes };
}

/** Tab label: the file name, prefixed by its parent directory when another open file shares the name. */
export function previewLabel(path: string, others: string[] = []): string {
  const name = baseName(path);
  if (!others.some((other) => other !== path && baseName(other) === name)) return name;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}

export interface LocalTarget {
  path: string;
  line?: number;
  column?: number;
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * What the user typed -> a local file, or undefined when it should stay a web address. Recognizes absolute
 * paths, `~/` paths (expanded when `home` is given), `./` and `../` paths (when `cwd` is given), `file://`
 * URLs and a trailing `:line[:col]`. Windows-looking input is rejected.
 */
export function parseLocalTarget(input: string, cwd?: string, home?: string): LocalTarget | undefined {
  let text = input.trim();
  if (!text || /^[a-z]:[\\/]/i.test(text) || text.startsWith("\\\\")) return undefined;
  const hashLine = /^(file:.*?)(#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i.exec(text);
  const fileAnchor = hashLine?.[2];
  if (hashLine) text = hashLine[1] ?? text;
  if (/^file:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (url.hostname && url.hostname !== "localhost") return undefined;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
    if (/^\/[a-z]:/i.test(path)) return undefined;
    text = fileAnchor ? path + fileAnchor : path;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith("//")) {
    return undefined;
  }
  let line: number | undefined;
  let column: number | undefined;
  // GitHub-style `#L10`, `#L10-L20`, `#L10C3`: the first line wins.
  const anchor = /^(.+?)#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/.exec(text);
  const position = anchor ?? /^(.+?):(\d+)(?::(\d+))?$/.exec(text);
  if (position) {
    text = position[1] ?? text;
    line = Number(position[2]);
    column = position[3] ? Number(position[3]) : undefined;
  }
  let path: string;
  if (text === "~" || text.startsWith("~/")) {
    path = home ? normalizePath(`${home}/${text.slice(2)}`) : text;
  } else if (text.startsWith("/")) {
    path = normalizePath(text);
  } else if (cwd && /^\.\.?\//.test(text)) {
    path = normalizePath(`${cwd}/${text}`);
  } else {
    return undefined;
  }
  const target: LocalTarget = { path };
  if (line !== undefined) target.line = line;
  if (column !== undefined) target.column = column;
  return target;
}

/** `pigna-file://<token>/<relative path>`; each segment is percent-encoded so `#`, `?` and spaces survive. */
export function previewUrl(token: string, relative: string, view?: PreviewMode | "raw"): string {
  const path = relative.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${PREVIEW_SCHEME}://${token}/${path}${view ? `?view=${view}` : ""}`;
}

export interface ParsedPreviewUrl {
  token: string;
  /** Decoded path relative to the root, no leading slash. */
  relative: string;
  view?: string;
  /** `?raw=1`: the viewer asks for the file bytes. */
  raw: boolean;
}

/** Inverse of `previewUrl`; undefined for other schemes or malformed escapes. */
export function parsePreviewUrl(url: string): ParsedPreviewUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:` || !parsed.hostname) return undefined;
  try {
    const relative = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/");
    return { token: parsed.hostname, relative, view: parsed.searchParams.get("view") ?? undefined, raw: parsed.searchParams.get("raw") === "1" };
  } catch {
    return undefined;
  }
}

/**
 * A Markdown link target that points at a local file rather than the web: absolute, `~/`, `./`, `../`,
 * bare relative (`src/a.ts`, `docs/x.md#L10`) and `file:` URLs. Any other scheme, `//host` and `#anchor`
 * stay web links.
 */
export function isLocalLinkHref(href: string): boolean {
  const text = href.trim();
  if (!text || text.startsWith("#") || text.startsWith("//") || text.startsWith("\\") || /^[a-z]:[\\/]/i.test(text)) return false;
  if (/^file:/i.test(text)) return true;
  // `scheme:` unless it is really `name.ts:12`.
  const scheme = /^([a-z][a-z0-9+.-]*):(\d+(?::\d+)?)?/i.exec(text);
  return !scheme || (scheme[2] !== undefined && scheme[1]!.includes(".") && scheme[0] === text);
}

/** A link target as a local file; relative input resolves against `cwd`, so it needs one. Percent-escapes decode. */
export function parseLinkTarget(href: string, cwd?: string, home?: string): LocalTarget | undefined {
  if (!isLocalLinkHref(href)) return undefined;
  let text = href.trim();
  if (!/^file:/i.test(text) && text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // keep the literal text
    }
  }
  if (!/^(file:|\/|~|\.\.?\/)/i.test(text)) text = `./${text}`;
  return parseLocalTarget(text, cwd, home);
}

/**
 * Inline code that reads as a file path (`src/a.ts`, `src/a.ts:12`, `/abs/x.md`, `README.md`). Deliberately
 * strict; the renderer only links candidates that exist.
 */
export function looksLikePath(code: string): boolean {
  const text = code.trim();
  if (!text || text.length > 300 || /[\s<>|*?(){}[\]"'`=,;$]/.test(text) || text.includes("://") || text.startsWith("-")) return false;
  const bare = text.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  const name = bare.split("/").pop() ?? "";
  if (!/^[\w@.+~-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(name) || name === ".") return false;
  if (bare.includes("/")) return !bare.endsWith("/");
  // A lone name needs an extension the preview knows (a.b, 1.2.3, e.g. are not files).
  return kindFor(bare) !== "other";
}
