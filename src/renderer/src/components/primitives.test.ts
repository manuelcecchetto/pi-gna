import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockFor, useNow } from "./primitives";

// Clocks are shared for the whole module, so each test uses its own intervals.
describe("shared clocks", () => {
  beforeEach(() => vi.useFakeTimers({ now: 10_250 }));
  afterEach(() => vi.useRealTimers());

  it("ticks every reader of every interval from one timer, on multiples of each interval", () => {
    const second = clockFor(1000);
    const half = clockFor(500);
    expect(clockFor(1000)).toBe(second);
    const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()];
    const offs = [second.subscribe(a), second.subscribe(b), half.subscribe(c)];
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(249);
    expect(c).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect([a.mock.calls.length, c.mock.calls.length]).toEqual([0, 1]);
    expect([second.read(), half.read()]).toEqual([10_250, 10_500]);
    // The second's tick and the half second's land in the same task.
    vi.advanceTimersByTime(500);
    expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([1, 1, 2]);
    expect(second.read()).toBe(11_000);
    expect(vi.getTimerCount()).toBe(1);
    // The half second's next tick leaves the second alone.
    vi.advanceTimersByTime(500);
    expect([a.mock.calls.length, c.mock.calls.length]).toEqual([1, 3]);
    offs[2]!();
    vi.advanceTimersByTime(500);
    expect([a.mock.calls.length, c.mock.calls.length]).toEqual([2, 3]);
    offs[0]!();
    offs[1]!();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads a stopped clock fresh to its interval, and steady within it", () => {
    const clock = clockFor(2000);
    vi.setSystemTime(12_100);
    expect(clock.read()).toBe(12_100);
    vi.setSystemTime(13_900);
    expect(clock.read()).toBe(12_100);
    vi.setSystemTime(14_000);
    expect(clock.read()).toBe(14_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still tells every listener of an interval another reader saw first", () => {
    const clock = clockFor(4000);
    const listener = vi.fn();
    const off = clock.subscribe(listener);
    vi.advanceTimersByTime(1749);
    vi.setSystemTime(12_000); // a render reads the new interval before the timer runs
    expect(clock.read()).toBe(12_000);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("renders the clock's time", () => {
    const Now = () => String(useNow(3000));
    expect(renderToStaticMarkup(createElement(Now))).toBe("10250");
  });
});
