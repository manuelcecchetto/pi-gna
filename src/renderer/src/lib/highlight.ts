// Lazy syntax highlighting: shiki core + JS regex engine, languages loaded on first use.
import type { GrammarState, hastToHtml, HighlighterCore, LanguageInput } from "shiki/core";

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

interface Engine {
  shiki: HighlighterCore;
  toHtml: typeof hastToHtml;
}

let core: Promise<Engine> | undefined;
const loaded = new Map<string, Promise<void>>();
/** The engine, under each language whose grammar has loaded. */
const ready = new Map<string, Engine>();
const cache = new Map<string, string>();
const CACHE_SIZE = 400;
/** Larger blocks stay plain: tokenizing takes up to ~9 ms per KB (TypeScript, both themes), even sliced up. */
export const BLOCK_LIMIT = 30_000;

function highlighter(): Promise<Engine> {
  core ??= (async () => {
    const [{ createHighlighterCore, hastToHtml }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark-default.mjs"),
    ]);
    const shiki = await createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
    return { shiki, toHtml: hastToHtml };
  })();
  return core;
}

/** cyrb53, a 53-bit string hash: the cache keys by it, so it does not hold every code string a second time. */
export function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const keyOf = (lang: string, code: string): string => `${lang}:${code.length}:${hash(code)}`;

function remember(key: string, html: string): void {
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  cache.set(key, html);
}

async function grammar(lang: string): Promise<Engine> {
  const engine = await highlighter();
  let load = loaded.get(lang);
  if (!load) {
    load = (LANGS[lang] as Loader)().then((mod) => engine.shiki.loadLanguage(mod.default));
    loaded.set(lang, load);
  }
  await load;
  ready.set(lang, engine);
  return engine;
}

const THEMES = { light: "github-light", dark: "github-dark-default" };
/** Characters tokenized per slice (whole lines, at least one): a few milliseconds, even for TypeScript. */
const SLICE_CHARS = 1_000;

/**
 * A block tokenized a slice of lines at a time, each slice going on from the grammar state the one before ended in,
 * so the joined slices are exactly the HTML of the whole block.
 */
interface Tokenizing {
  lines: string[];
  /** Lines tokenized so far. */
  done: number;
  html: string[];
  state?: GrammarState;
}

const tokenizing = (code: string): Tokenizing => ({ lines: code.split(/\r?\n/), done: 0, html: [] });

/** Tokenizes the next slice; returns whether the block is complete. */
function step({ shiki, toHtml }: Engine, lang: string, run: Tokenizing): boolean {
  let end = run.done;
  for (let size = 0; end < run.lines.length && (end === run.done || size + (run.lines[end] as string).length < SLICE_CHARS); end++) {
    size += (run.lines[end] as string).length + 1;
  }
  const hast = shiki.codeToHast(run.lines.slice(run.done, end).join("\n"), { lang, themes: THEMES, defaultColor: false, grammarState: run.state });
  run.state = shiki.getLastGrammarState(hast);
  run.html.push(toHtml(hast).match(/<code>([\s\S]*)<\/code>/)?.[1] ?? "");
  run.done = end;
  return end === run.lines.length;
}

/** Highlighted inner HTML for a <code> element, or undefined for unsupported languages. Runs at once; blocks in a page go through observeHighlight. */
export async function highlight(code: string, hint: string | undefined, limit = BLOCK_LIMIT): Promise<string | undefined> {
  const lang = resolveLang(hint);
  if (!lang || code.length > limit) return undefined;
  const key = keyOf(lang, code);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const engine = await grammar(lang);
  const run = tokenizing(code);
  while (!step(engine, lang, run));
  const inner = run.html.join("\n");
  remember(key, inner);
  return inner;
}

// Blocks are highlighted as they near the viewport, one per idle callback and a slice at a time, so neither a finished
// message nor an opened session tokenizes in one long task.

interface Job {
  target: Element;
  code: string;
  lang: string;
  key: string;
  apply(html: string): void;
  live?: () => boolean;
  io: IntersectionObserver;
  /** Its progress; a block that scrolls away keeps it. */
  run?: Tokenizing;
}

/** The job waiting on each observed target. */
const jobs = new WeakMap<Element, Job>();
/** Jobs whose target is near the viewport, oldest first. */
const due = new Set<Job>();
let pumping = false;

/** Idle time one callback spends tokenizing, at most: past it the slice under way finishes and the rest waits. */
const IDLE_BUDGET_MS = 8;

const idle: (work: (deadline: IdleDeadline) => void) => void =
  typeof requestIdleCallback === "function"
    ? (work) => requestIdleCallback(work, { timeout: 300 })
    : (work) => setTimeout(() => work({ didTimeout: true, timeRemaining: () => 0 }), 0); // Safari has no requestIdleCallback

function drop(job: Job): void {
  due.delete(job);
  if (jobs.get(job.target) !== job) return;
  jobs.delete(job.target);
  job.io.unobserve(job.target);
}

/** How far `target` is from its observer's visible area, in pixels; 0 when it shows. */
function distance(target: Element, root: Element | Document | null): number {
  const box = target.getBoundingClientRect();
  const view = root && "getBoundingClientRect" in root ? root.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  return Math.max(0, view.top - box.bottom, box.top - view.bottom);
}

/** The due job nearest its visible area, so blocks on screen go before those in the margin; the oldest among equals. */
function nearest(): Job | undefined {
  let best: Job | undefined;
  let gap = Infinity;
  for (const job of due) {
    const d = distance(job.target, job.io.root);
    if (d < gap) [best, gap] = [job, d];
    if (gap === 0) break;
  }
  return best;
}

/** In the next idle callback, tokenizes slices of the nearest due block while the idle time lasts; the rest goes on in the next. */
function pump(): void {
  if (pumping || !due.size) return;
  pumping = true;
  idle((deadline) => {
    const job = nearest();
    const engine = job && ready.get(job.lang);
    if (job && !engine) {
      // Its grammar loads first, outside the idle callback.
      grammar(job.lang).then(
        () => {
          pumping = false;
          pump();
        },
        () => {
          drop(job);
          pumping = false;
          pump();
        },
      );
      return;
    }
    try {
      if (!job || !engine) return;
      if (!job.target.isConnected || job.live?.() === false) return drop(job);
      let html = cache.get(job.key);
      if (html === undefined) {
        const run = (job.run ??= tokenizing(job.code));
        const until = performance.now() + Math.min(deadline.timeRemaining(), IDLE_BUDGET_MS);
        while (!step(engine, job.lang, run)) if (performance.now() >= until) return;
        html = run.html.join("\n");
        remember(job.key, html);
      }
      drop(job);
      job.apply(html);
    } catch {
      if (job) drop(job); // a block shiki cannot tokenize stays plain
    } finally {
      pumping = false;
      pump();
    }
  });
}

/** The nearest ancestor that scrolls, so the observer's margin reaches past its clip; null means the viewport. */
function scrollRoot(from: Element | null): Element | null {
  for (let el = from; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

// One observer per scroller; a closed chat's scroller is dropped with it.
const observers = new WeakMap<Element, IntersectionObserver>();
let viewportObserver: IntersectionObserver | undefined;

function observer(root: Element | null): IntersectionObserver {
  let found = root ? observers.get(root) : viewportObserver;
  if (!found) {
    found = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          const job = jobs.get(target);
          if (!job) continue;
          if (isIntersecting) due.add(job);
          else due.delete(job);
        }
        pump();
      },
      { root, rootMargin: "800px 0px" },
    );
    if (root) observers.set(root, found);
    else viewportObserver = found;
  }
  return found;
}

/**
 * Highlights `code` into `apply` once `target` nears the viewport of `root` (by default its nearest scroller); a cached
 * result applies at once. Returns a function that cancels it; a due job whose `live` check fails is dropped too.
 */
export function observeHighlight(
  target: Element,
  code: string,
  hint: string | undefined,
  apply: (html: string) => void,
  options: { root?: Element | null; live?: () => boolean } = {},
): () => void {
  const lang = resolveLang(hint);
  if (!lang || code.length > BLOCK_LIMIT) return () => {};
  const key = keyOf(lang, code);
  const hit = cache.get(key);
  if (hit !== undefined) {
    apply(hit);
    return () => {};
  }
  const io = observer(options.root === undefined ? scrollRoot(target.parentElement) : options.root);
  const previous = jobs.get(target);
  if (previous) drop(previous);
  const job: Job = { target, code, lang, key, apply, live: options.live, io };
  jobs.set(target, job);
  io.observe(target);
  return () => drop(job);
}

/** Highlights the unhighlighted code blocks in a rendered markdown container as they near the viewport. Returns a cleanup. */
export function highlightWithin(root: HTMLElement | null): () => void {
  if (!root) return () => {};
  const scroller = scrollRoot(root);
  const cancels: (() => void)[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("code[data-lang]:not(.hl)")) {
    const text = element.textContent ?? "";
    const apply = (html: string) => {
      element.innerHTML = html;
      element.classList.add("hl");
    };
    cancels.push(observeHighlight(element, text, element.dataset.lang, apply, { root: scroller, live: () => element.textContent === text }));
  }
  return () => {
    for (const cancel of cancels) cancel();
  };
}
