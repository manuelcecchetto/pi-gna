import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  report(...entries: [Element, boolean][]) {
    this.callback(entries.map(([target, isIntersecting]) => ({ target, isIntersecting })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

/** An element whose computed overflow-y is `overflowY`, under `parent`. */
function element(parent: Element | null = null, overflowY = "visible") {
  return { parentElement: parent, overflowY } as unknown as Element;
}

describe("watchNear", () => {
  let mod: typeof import("./near");
  const body = element();
  beforeEach(async () => {
    FakeObserver.made = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.stubGlobal("document", { body });
    vi.stubGlobal("getComputedStyle", (el: { overflowY: string }) => ({ overflowY: el.overflowY }));
    vi.resetModules();
    mod = await import("./near");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a target entering and leaving the margin of its nearest scroller", () => {
    const scroller = element(body, "auto");
    const target = element(element(scroller));
    const seen: boolean[] = [];
    mod.watchNear(target, (near) => seen.push(near));
    const [io] = FakeObserver.made;
    expect(io?.options).toEqual({ root: scroller, rootMargin: "100% 0px" });
    expect(io?.targets.has(target)).toBe(true);
    io?.report([target, true]);
    io?.report([target, false], [target, true]);
    expect(seen).toEqual([true, false, true]);
  });

  it("shares one observer per scroller, and uses the viewport outside any", () => {
    const one = element(body, "scroll");
    const two = element(body, "auto");
    mod.watchNear(element(one), () => {});
    mod.watchNear(element(element(one)), () => {});
    mod.watchNear(element(two), () => {});
    mod.watchNear(element(body), () => {});
    mod.watchNear(element(element(body, "hidden")), () => {});
    expect(FakeObserver.made.map((io) => io.options.root)).toEqual([one, two, null]);
    expect(FakeObserver.made.map((io) => io.targets.size)).toEqual([2, 1, 2]);
  });

  it("looks for the scroller above the target, not at the target itself", () => {
    const scroller = element(body, "auto");
    mod.watchNear(element(scroller, "auto"), () => {});
    expect(FakeObserver.made[0]?.options.root).toBe(scroller);
  });

  it("routes each entry to its own target's callback", () => {
    const scroller = element(body, "auto");
    const a = element(scroller);
    const b = element(scroller);
    const seen: string[] = [];
    mod.watchNear(a, (near) => seen.push(`a${near}`));
    mod.watchNear(b, (near) => seen.push(`b${near}`));
    FakeObserver.made[0]?.report([b, true], [a, false]);
    expect(seen).toEqual(["btrue", "afalse"]);
  });

  it("stops watching on cleanup", () => {
    const scroller = element(body, "auto");
    const target = element(scroller);
    const seen: boolean[] = [];
    const stop = mod.watchNear(target, (near) => seen.push(near));
    const io = FakeObserver.made[0] as FakeObserver;
    stop();
    expect(io.targets.has(target)).toBe(false);
    io.report([target, true]);
    expect(seen).toEqual([]);
  });

  it("counts everything as near without IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.resetModules();
    const bare = await import("./near");
    const seen: boolean[] = [];
    bare.watchNear(element(body), (near) => seen.push(near));
    expect(seen).toEqual([true]);
  });
});
