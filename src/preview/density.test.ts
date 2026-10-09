import { afterEach, describe, expect, it, vi } from "vitest";
import { watchDensity } from "./density";

/** A window whose density the test sets; `(resolution: Ndppx)` queries match only the density they were made at. */
function fakeWindow(start: number) {
  let dpr = start;
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const resize = new Set<() => void>();
  vi.stubGlobal("devicePixelRatio", start);
  vi.stubGlobal("matchMedia", (media: string) => {
    const query = { media, listeners: new Set<() => void>() };
    queries.push(query);
    return { media, addEventListener: (_: string, fn: () => void) => query.listeners.add(fn), removeEventListener: (_: string, fn: () => void) => query.listeners.delete(fn) };
  });
  vi.stubGlobal("addEventListener", (type: string, fn: () => void) => type === "resize" && resize.add(fn));
  vi.stubGlobal("removeEventListener", (type: string, fn: () => void) => type === "resize" && resize.delete(fn));
  return {
    queries,
    resize,
    /** Move to another density: the browser tells the queries that stopped matching. */
    set(next: number) {
      const old = `(resolution: ${dpr}dppx)`;
      dpr = next;
      vi.stubGlobal("devicePixelRatio", next);
      for (const query of queries.filter((q) => q.media === old)) for (const fn of [...query.listeners]) fn();
    },
    listening: () => queries.reduce((n, q) => n + q.listeners.size, 0),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("watchDensity", () => {
  it("reports every density change, re-arming the query at the new density", () => {
    const win = fakeWindow(2);
    const changed = vi.fn();
    watchDensity(changed);
    expect(win.queries.map((q) => q.media)).toEqual(["(resolution: 2dppx)"]);
    win.set(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(win.queries.at(-1)?.media).toBe("(resolution: 1dppx)");
    win.set(3);
    win.set(2);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(win.listening()).toBe(1);
  });
  it("also reports a resize, and stops listening when unsubscribed", () => {
    const win = fakeWindow(2);
    const changed = vi.fn();
    const stop = watchDensity(changed);
    for (const fn of win.resize) fn();
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    expect(win.listening()).toBe(0);
    expect(win.resize.size).toBe(0);
    win.set(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
