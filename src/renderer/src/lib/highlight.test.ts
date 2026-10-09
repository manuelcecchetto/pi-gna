import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { BLOCK_LIMIT, hash, highlight } from "./highlight";

// shiki gives up on a line after 500 ms of wall time and leaves the rest of it plain, so on a loaded machine the two
// sides of an equality check could stop at different places. Here neither does: every highlighter tokenizes in full.
vi.mock("shiki/core", async (original) => {
  const shiki = await original<typeof import("shiki/core")>();
  return {
    ...shiki,
    createHighlighterCore: async (...args: Parameters<typeof shiki.createHighlighterCore>) => {
      const core = await shiki.createHighlighterCore(...args);
      const { codeToHast, codeToHtml } = core;
      return Object.assign(core, {
        codeToHast: (code: string, options: Parameters<typeof codeToHast>[1]) => codeToHast(code, { ...options, tokenizeTimeLimit: 0 }),
        codeToHtml: (code: string, options: Parameters<typeof codeToHtml>[1]) => codeToHtml(code, { ...options, tokenizeTimeLimit: 0 }),
      });
    },
  };
});

// What shiki makes of the whole block at once: sliced highlighting must give exactly this.
let reference: HighlighterCore;
beforeAll(async () => {
  reference = await createHighlighterCore({
    themes: [(await import("shiki/themes/github-light.mjs")).default, (await import("shiki/themes/github-dark-default.mjs")).default],
    langs: [(await import("shiki/langs/typescript.mjs")).default, (await import("shiki/langs/json.mjs")).default],
    engine: createJavaScriptRegexEngine(),
  });
});
const whole = (code: string, lang: string) =>
  reference.codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark-default" }, defaultColor: false }).match(/<code>([\s\S]*)<\/code>/)?.[1];

// About 3 KB of TypeScript, with a template literal and a comment that run across slices.
const TS = Array.from(
  { length: 60 },
  (_, i) => (i % 9 === 4 ? "const text = `a template\nthat spans ${i} lines\nof code`;" : i % 7 === 2 ? "/* a comment\n   across lines */ let x = 1;" : `export function f${i}(value: number): string { return String(value * ${i}); }`),
).join("\n");

describe("hash", () => {
  it("is cyrb53", () => {
    expect([hash(""), hash("a"), hash("b"), hash("revenge"), hash("revenue")]).toEqual([3338908027751811, 7929297801672961, 8684336938537663, 4051478007546757, 8309097637345594]);
  });
});

describe("highlight", () => {
  it("gives what shiki gives for the whole block, however it is sliced", async () => {
    expect(TS.length).toBeGreaterThan(3000);
    for (const code of [TS, `${TS}\n`, TS.replaceAll("\n", "\r\n"), "", "x".repeat(2500), `{\n  "a": [1, 2],\n  "b": "${"c".repeat(1200)}"\n}`]) {
      const lang = code.startsWith("{") ? "json" : "typescript";
      expect(await highlight(code, lang)).toBe(whole(code, lang));
    }
    // The first block of a language compiles its grammar's expressions: seconds on a loaded machine.
  }, 30_000);

  it("leaves blocks over the limit and unknown languages plain, unless a caller allows more", async () => {
    expect(BLOCK_LIMIT).toBe(30_000);
    const at = `[${"1,".repeat(14_998)}12]`; // 30,000 characters
    expect(at).toHaveLength(30_000);
    expect(await highlight(at, "json")).toBeDefined();
    expect(await highlight(`${at} `, "json")).toBeUndefined();
    expect(await highlight(`${at} `, "json", 40_000)).toBeDefined();
    expect(await highlight("x = 1", "brainfuck")).toBeUndefined();
    expect(await highlight("x = 1", undefined)).toBeUndefined();
  });

  it("caches by language and content", async () => {
    const first = await highlight("const a = 1;", "ts");
    expect(await highlight("const a = 1;", "typescript")).toBe(first);
    expect(await highlight("const b = 1;", "ts")).not.toBe(first);
    expect(await highlight("const a = 1;", "json")).not.toBe(first);
  });
});

/** Stands in for IntersectionObserver: the test reports which targets enter or leave the margin. */
class FakeObserver {
  static made: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.made.push(this);
  }
  get root() {
    return this.options.root ?? null;
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {}
  report(...entries: [Element, boolean][]) {
    this.callback(entries.map(([target, isIntersecting]) => ({ target, isIntersecting })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

/** A code element `top` pixels down a viewport of 800. */
function block(top = 100) {
  return { isConnected: true, parentElement: null, getBoundingClientRect: () => ({ top, bottom: top + 50 }) } as unknown as Element & { isConnected: boolean };
}

describe("observeHighlight", () => {
  let mod: typeof import("./highlight");
  let idles: { work: IdleRequestCallback; options?: IdleRequestOptions }[];
  const observer = () => FakeObserver.made.at(-1) as FakeObserver;
  /** Waits for the grammar to load and the next idle callback to be asked for. */
  const idleAsked = () => vi.waitFor(() => expect(idles.length).toBeGreaterThan(0));
  /** Runs the next idle callback with `left` milliseconds of idle time. */
  const runIdle = (left = 0) => {
    const next = idles.shift();
    if (!next) throw new Error("no idle callback");
    next.work({ didTimeout: left === 0, timeRemaining: () => left });
  };
  const json = (n: number) => `{"n": ${n}, "list": [${Array.from({ length: n }, (_, i) => i).join(", ")}]}`;

  beforeEach(async () => {
    idles = [];
    FakeObserver.made = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("requestIdleCallback", (work: IdleRequestCallback, options?: IdleRequestOptions) => idles.push({ work, options }));
    vi.resetModules();
    mod = await import("./highlight");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("highlights a block once it nears the viewport, in an idle callback", async () => {
    const target = block();
    const apply = vi.fn();
    mod.observeHighlight(target, json(3), "json", apply, { root: null });
    expect(observer().options).toEqual({ root: null, rootMargin: "800px 0px" });
    expect(observer().targets.has(target)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idles).toHaveLength(0);
    observer().report([target, true]);
    await idleAsked();
    expect(idles[0]?.options).toEqual({ timeout: 300 });
    runIdle(); // the grammar was not loaded: this callback loads it
    await idleAsked();
    runIdle();
    expect(apply).toHaveBeenCalledExactlyOnceWith(await mod.highlight(json(3), "json"));
    expect(observer().targets.has(target)).toBe(false);
    expect(idles).toHaveLength(0);
  });

  it("applies a cached result at once, and skips blocks it would not highlight", async () => {
    await mod.highlight(json(4), "json");
    const apply = vi.fn();
    mod.observeHighlight(block(), json(4), "json", apply, { root: null });
    expect(apply).toHaveBeenCalledExactlyOnceWith(await mod.highlight(json(4), "json"));
    mod.observeHighlight(block(), "x".repeat(BLOCK_LIMIT + 1), "json", apply, { root: null });
    mod.observeHighlight(block(), "x = 1", "brainfuck", apply, { root: null });
    expect(FakeObserver.made).toHaveLength(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does the block nearest the visible area first, one block per idle callback", async () => {
    await mod.highlight("{}", "json"); // the grammar is loaded
    // 50 px above the viewport, 700 px below it, at its foot, and two 200 px below it.
    const [above, far, shown, below1, below2] = [block(-100), block(1500), block(700), block(1000), block(1000)];
    const names = new Map<Element, string>([[above, "above"], [far, "far"], [shown, "shown"], [below1, "below1"], [below2, "below2"]]);
    const applied: string[] = [];
    for (const [target, name] of names) mod.observeHighlight(target, json(20 + [...names.values()].indexOf(name)), "json", () => applied.push(name), { root: null });
    observer().report([above, true], [far, true], [shown, true], [below1, true], [below2, true]);
    await idleAsked();
    runIdle(50);
    expect(applied).toEqual(["shown"]);
    while (idles.length) runIdle(50);
    expect(applied).toEqual(["shown", "above", "below1", "below2", "far"]);
  });

  it("measures distance from a scroller root when there is one", async () => {
    await mod.highlight("{}", "json");
    const scroller = { getBoundingClientRect: () => ({ top: 1000, bottom: 1400 }) } as unknown as Element;
    const [above, inside] = [block(500), block(1200)];
    const applied: string[] = [];
    mod.observeHighlight(above, json(5), "json", () => applied.push("above"), { root: scroller });
    mod.observeHighlight(inside, json(6), "json", () => applied.push("inside"), { root: scroller });
    expect(FakeObserver.made).toHaveLength(1);
    expect(observer().options).toEqual({ root: scroller, rootMargin: "800px 0px" });
    observer().report([above, true], [inside, true]);
    await idleAsked();
    runIdle(50);
    expect(applied).toEqual(["inside"]);
  });

  it("tokenizes a long block a slice at a time, within the idle time and a budget", async () => {
    await mod.highlight("{}", "json");
    // Twelve lines of 600 characters, a slice each.
    const code = (seed: number) => Array.from({ length: 12 }, (_, i) => `"${String(seed + i).repeat(598).slice(0, 598)}"`).join("\n");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 4)); // a slice takes 4 ms
    const callbacks = async (left: number) => {
      const target = block();
      const apply = vi.fn();
      mod.observeHighlight(target, code(left), "json", apply, { root: null });
      observer().report([target, true]);
      let n = 0;
      while (!apply.mock.calls.length) {
        await idleAsked();
        runIdle(left);
        n++;
      }
      expect(apply).toHaveBeenCalledExactlyOnceWith(whole(code(left), "json"));
      return n;
    };
    // One slice per callback without idle time or once it is used up, two within 6 ms of it, two within the 8 ms
    // budget out of 50.
    expect(await callbacks(0)).toBe(12);
    expect(await callbacks(4)).toBe(12);
    expect(await callbacks(6)).toBe(6);
    expect(await callbacks(50)).toBe(6);
  });

  it("pauses a block that leaves the margin and resumes it from where it was", async () => {
    await mod.highlight("{}", "json");
    const code = Array.from({ length: 2 }, (_, i) => `"${String(i).repeat(900)}"`).join("\n");
    const target = block();
    const apply = vi.fn();
    mod.observeHighlight(target, code, "json", apply, { root: null });
    observer().report([target, true]);
    await idleAsked();
    runIdle();
    expect(apply).not.toHaveBeenCalled();
    observer().report([target, false]);
    await idleAsked();
    runIdle();
    expect(idles).toHaveLength(0);
    expect(observer().targets.has(target)).toBe(true);
    observer().report([target, true]);
    await idleAsked();
    runIdle();
    expect(apply).toHaveBeenCalledExactlyOnceWith(whole(code, "json"));
    expect(idles).toHaveLength(0);
  });

  it("drops a block that is cancelled, replaced, detached or no longer live", async () => {
    await mod.highlight("{}", "json");
    const [cancelled, replaced, detached, stale] = [block(), block(), block(), block()];
    const applied: string[] = [];
    const cancel = mod.observeHighlight(cancelled, json(7), "json", () => applied.push("cancelled"), { root: null });
    const cancelOld = mod.observeHighlight(replaced, json(8), "json", () => applied.push("old"), { root: null });
    observer().report([replaced, true]);
    // Replaced while due: the new job is observed afresh (a real observer reports a target only when observed anew).
    const unobserve = vi.spyOn(observer(), "unobserve");
    mod.observeHighlight(replaced, json(9), "json", () => applied.push("new"), { root: null });
    expect(unobserve).toHaveBeenCalledWith(replaced);
    cancelOld();
    mod.observeHighlight(detached, json(10), "json", () => applied.push("detached"), { root: null });
    mod.observeHighlight(stale, json(11), "json", () => applied.push("stale"), { root: null, live: () => false });
    observer().report([cancelled, true], [replaced, true], [detached, true], [stale, true]);
    expect(idles).toHaveLength(1); // one idle callback at a time
    cancel();
    detached.isConnected = false;
    expect(observer().targets.has(cancelled)).toBe(false);
    await idleAsked();
    while (idles.length) runIdle(50);
    expect(applied).toEqual(["new"]);
    expect(observer().targets.size).toBe(0);
  });

  it("finds the nearest scroller as the root, and highlights within a rendered container", async () => {
    await mod.highlight("{}", "json");
    const styles = new Map<unknown, string>();
    vi.stubGlobal("getComputedStyle", (el: unknown) => ({ overflowY: styles.get(el) ?? "visible" }));
    const body = { parentElement: null };
    const scroller = { parentElement: body, getBoundingClientRect: () => ({ top: 0, bottom: 800 }) };
    const prose = { parentElement: scroller };
    vi.stubGlobal("document", { body });
    styles.set(scroller, "auto");
    styles.set(body, "scroll");
    const code = (lang: string, text: string) => {
      const el = { ...block(), parentElement: prose, dataset: { lang }, textContent: text, innerHTML: "", classes: [] as string[] };
      return Object.assign(el, { classList: { add: (name: string) => el.classes.push(name) } });
    };
    const els = [code("json", json(12)), code("json", json(13)), code("json", json(16))];
    const root = { ...prose, querySelectorAll: (selector: string) => (selector === "code[data-lang]:not(.hl)" ? els : []) } as unknown as HTMLElement;
    const stop = mod.highlightWithin(root);
    expect(observer().options.root).toBe(scroller);
    observer().report([els[0] as unknown as Element, true], [els[1] as unknown as Element, true]);
    (els[1] as { textContent: string }).textContent = "changed";
    await idleAsked();
    runIdle(50);
    expect(els[0]?.innerHTML).toBe(await mod.highlight(json(12), "json"));
    expect(els[0]?.classes).toEqual(["hl"]);
    if (idles.length) runIdle(50);
    expect(els[1]?.classes).toEqual([]);
    expect(observer().targets.size).toBe(1); // the third never came near
    stop();
    expect(observer().targets.size).toBe(0);
    // An explicit root wins over the scrolling ancestor.
    mod.observeHighlight({ ...block(), parentElement: prose } as unknown as Element, json(17), "json", vi.fn(), { root: null });
    expect(observer().options.root).toBeNull();
    // Without a scrolling ancestor below the body, the viewport is the root.
    styles.set(scroller, "hidden");
    mod.observeHighlight(block(), json(14), "json", vi.fn(), {});
    const target = { ...block(), parentElement: prose } as unknown as Element;
    mod.observeHighlight(target, json(15), "json", vi.fn());
    expect(observer().options.root).toBeNull();
    expect(mod.highlightWithin(null)).toBeTypeOf("function");
  });

  it("uses a zero-delay timer, a slice per task, where there is no requestIdleCallback", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const timers: (() => void)[] = [];
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((work: () => void, delay?: number) =>
      delay === 0 ? timers.push(work) : later(work, delay)) as typeof setTimeout);
    vi.resetModules();
    mod = await import("./highlight");
    await mod.highlight("{}", "json");
    const code = Array.from({ length: 2 }, (_, i) => `"${String(i).repeat(900)}"`).join("\n");
    const target = block();
    const apply = vi.fn();
    mod.observeHighlight(target, code, "json", apply, { root: null });
    observer().report([target, true]);
    for (let i = 0; i < 2; i++) {
      expect(apply).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
      timers.shift()?.();
    }
    expect(apply).toHaveBeenCalledExactlyOnceWith(whole(code, "json"));
  });
});
