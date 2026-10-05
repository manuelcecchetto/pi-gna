// Lazy syntax highlighting: shiki core + JS regex engine, languages loaded on first use.
import type { HighlighterCore, LanguageInput } from "shiki/core";

type Loader = () => Promise<{ default: LanguageInput }>;

const LANGS: Record<string, Loader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  svg: "xml",
  kt: "kotlin",
  rb: "ruby",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  patch: "diff",
  gql: "graphql",
};

export function resolveLang(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const key = hint.toLowerCase().trim();
  const lang = ALIASES[key] ?? key;
  return lang in LANGS ? lang : undefined;
}

export function langFromPath(path: string): string | undefined {
  const base = path.split("/").at(-1) ?? "";
  if (base === "Dockerfile") return "dockerfile";
  return resolveLang(base.includes(".") ? base.split(".").at(-1) : undefined);
}

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();
const cache = new Map<string, string>();

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark-default.mjs"),
    ]);
    return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return core;
}

/** Highlighted inner HTML for a <code> element, or undefined for unsupported languages. */
export async function highlight(code: string, hint: string | undefined, limit = 200_000): Promise<string | undefined> {
  const lang = resolveLang(hint);
  if (!lang || code.length > limit) return undefined;
  const cacheKey = `${lang}\0${code}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const shiki = await highlighter();
  let load = loaded.get(lang);
  if (!load) {
    load = (LANGS[lang] as Loader)().then((mod) => shiki.loadLanguage(mod.default));
    loaded.set(lang, load);
  }
  await load;
  const html = shiki.codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark-default" }, defaultColor: false });
  const inner = html.match(/<code>([\s\S]*)<\/code>/)?.[1] ?? "";
  if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, inner);
  return inner;
}

/** Highlight every unhighlighted code block inside a rendered markdown container. */
export function highlightWithin(root: HTMLElement | null): void {
  if (!root) return;
  for (const element of root.querySelectorAll<HTMLElement>("code[data-lang]:not(.hl)")) {
    const text = element.textContent ?? "";
    void highlight(text, element.dataset.lang).then((html) => {
      if (html === undefined || element.textContent !== text) return;
      element.innerHTML = html;
      element.classList.add("hl");
    });
  }
}
