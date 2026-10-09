import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test gets a fresh module: deferred() registers every component for preloadDeferred().
const fresh = async () => {
  vi.resetModules();
  return import("./deferred");
};
const Page = ({ title }: { title: string }) => createElement("h1", null, title);
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A PerformanceObserver that sees paint entries when the test emits them. */
function stubPaintObserver() {
  const observers: { callback: PerformanceObserverCallback; connected: boolean }[] = [];
  class Observer {
    static supportedEntryTypes = ["paint"];
    entry: { callback: PerformanceObserverCallback; connected: boolean };
    constructor(callback: PerformanceObserverCallback) {
      this.entry = { callback, connected: false };
      observers.push(this.entry);
    }
    observe() {
      this.entry.connected = true;
    }
    disconnect() {
      this.entry.connected = false;
    }
  }
  vi.stubGlobal("PerformanceObserver", Observer);
  return {
    emit(name: string) {
      const list = { getEntriesByName: (wanted: string) => (wanted === name ? [{ name }] : []) } as unknown as PerformanceObserverEntryList;
      for (const observer of observers.filter((entry) => entry.connected)) observer.callback(list, observer as unknown as PerformanceObserver);
    },
    disconnected: () => observers.every((entry) => !entry.connected),
  };
}

describe("deferred", () => {
  beforeEach(() => vi.stubGlobal("requestIdleCallback", undefined));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders nothing until its chunk has loaded, then renders the component in the same pass", async () => {
    const { deferred } = await fresh();
    const load = vi.fn(async () => Page);
    const Lazy = deferred(load);
    expect(renderToStaticMarkup(createElement(Lazy, { title: "Kanban" }))).toBe("");
    expect(load).not.toHaveBeenCalled(); // not at import: only when shown or preloaded
    await Lazy.preload();
    expect(renderToStaticMarkup(createElement(Lazy, { title: "Kanban" }))).toBe("<h1>Kanban</h1>");
  });

  it("loads its chunk once", async () => {
    const { deferred } = await fresh();
    const load = vi.fn(async () => Page);
    const Lazy = deferred(load);
    await Promise.all([Lazy.preload(), Lazy.preload()]);
    await Lazy.preload();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tries again after a chunk failed to load", async () => {
    const { deferred } = await fresh();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue(Page);
    const Lazy = deferred<{ title: string }>(load);
    await Lazy.preload();
    expect(error).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(createElement(Lazy, { title: "x" }))).toBe("");
    await Lazy.preload();
    expect(load).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(createElement(Lazy, { title: "x" }))).toBe("<h1>x</h1>");
  });

  it("preloads every chunk once the window is idle after its first contentful paint, at the latest after the timeout", async () => {
    const idles: { work: () => void; options?: IdleRequestOptions }[] = [];
    vi.stubGlobal("requestIdleCallback", (work: () => void, options?: IdleRequestOptions) => idles.push({ work, options }));
    const paint = stubPaintObserver();
    const { deferred, preloadDeferred } = await fresh();
    const loads = [vi.fn(async () => Page), vi.fn(async () => Page)];
    const pages = loads.map((load) => deferred<{ title: string }>(load));
    preloadDeferred();
    await flush();
    expect(idles).toEqual([]); // idle while it waits on its first images: chunk requests would slow those
    paint.emit("first-paint");
    await flush();
    expect(idles).toEqual([]);
    paint.emit("first-contentful-paint");
    await flush();
    expect(paint.disconnected()).toBe(true);
    expect(idles.map((idle) => idle.options)).toEqual([{ timeout: 2000 }]);
    expect(loads.map((load) => load.mock.calls.length)).toEqual([0, 0]);
    idles[0]!.work();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1]);
    await Promise.all(pages.map((page) => page.preload()));
    expect(pages.map((page) => renderToStaticMarkup(createElement(page, { title: "p" })))).toEqual(["<h1>p</h1>", "<h1>p</h1>"]);
  });

  it("waits at most 3 s for a first paint, for a window that starts hidden", async () => {
    vi.useFakeTimers();
    const paint = stubPaintObserver();
    const { firstPaint } = await fresh();
    let painted = false;
    void firstPaint().then(() => (painted = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(painted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(painted).toBe(true);
    expect(paint.disconnected()).toBe(true);
  });

  it("can be cancelled, as App's effect cleanup does, before or after the first paint", async () => {
    const cancel = vi.fn();
    const idle = vi.fn(() => 7);
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", cancel);
    const paint = stubPaintObserver();
    const { preloadDeferred } = await fresh();
    preloadDeferred()(); // before: nothing is scheduled at all
    const stop = preloadDeferred();
    paint.emit("first-contentful-paint");
    await flush();
    expect(idle).toHaveBeenCalledOnce();
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("uses a zero-delay timer where there is no requestIdleCallback", async () => {
    vi.useFakeTimers();
    const paint = stubPaintObserver();
    const { deferred, preloadDeferred } = await fresh();
    const load = vi.fn(async () => Page);
    deferred(load);
    preloadDeferred();
    paint.emit("first-contentful-paint");
    await flush();
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(load).toHaveBeenCalledOnce();
  });
});
