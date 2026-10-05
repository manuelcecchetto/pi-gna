import { describe, expect, it } from "vitest";
import { FrameGate, frameParams, inputPoint, mergeFrameParams, parseViewer, sameFrameParams } from "./browser-view";
import { fitViewport } from "./viewport";

/** A clock the test advances by hand; `later` timers fire in order when time passes. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let next = 0;
  return {
    now: () => now,
    later(ms: number, run: () => void) {
      const timer = { at: now + ms, run, id: next++ };
      timers.push(timer);
      return timer.id;
    },
    cancel(handle: unknown) {
      const at = timers.findIndex((t) => t.id === handle);
      if (at >= 0) timers.splice(at, 1);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > end) break;
        timers.shift();
        now = due.at;
        due.run();
      }
      now = end;
    },
  };
}

describe("parseViewer", () => {
  it("accepts numbers and strings, clamps, and falls back to a phone", () => {
    expect(parseViewer("390", "844", "3")).toEqual({ width: 390, height: 844, dpr: 3 });
    expect(parseViewer(undefined, null, "abc")).toEqual({ width: 390, height: 844, dpr: 2 });
    expect(parseViewer(99999, 1, 99)).toEqual({ width: 4000, height: 100, dpr: 4 });
  });
});

describe("frameParams", () => {
  it("asks for no more pixels than the viewer shows", () => {
    const p = frameParams({ width: 390, height: 844, dpr: 3 });
    expect(p.maxWidth).toBe(1170);
    expect(p.maxHeight).toBe(1800); // 2532 clamped
    expect(frameParams({ width: 390, height: 844, dpr: 1 }).maxWidth).toBe(390);
    expect(frameParams({ width: 390, height: 844, dpr: 4 }).maxWidth).toBe(1170); // DPR above 3 buys nothing
  });

  it("lowers fps and quality as frames grow", () => {
    const small = frameParams({ width: 320, height: 568, dpr: 1 });
    const big = frameParams({ width: 1024, height: 1366, dpr: 2 });
    expect(small.fps).toBe(30);
    expect(small.everyNthFrame).toBe(2);
    expect(big.fps).toBeLessThan(small.fps);
    expect(big.quality).toBeLessThan(small.quality);
  });

  it("merges viewers of one tab to the biggest ask and compares settings", () => {
    const a = frameParams({ width: 320, height: 568, dpr: 1 });
    const b = frameParams({ width: 1024, height: 1366, dpr: 2 });
    const merged = mergeFrameParams([a, b])!;
    expect(merged.maxWidth).toBe(b.maxWidth);
    expect(merged.fps).toBe(a.fps);
    expect(mergeFrameParams([])).toBeUndefined();
    expect(sameFrameParams(a, { ...a })).toBe(true);
    expect(sameFrameParams(a, b)).toBe(false);
    expect(sameFrameParams(undefined, a)).toBe(false);
  });
});

describe("inputPoint", () => {
  const page = { width: 390, height: 844 };

  it("passes CSS px through at scale 1", () => {
    expect(inputPoint(100, 200, page, 1)).toEqual({ x: 100, y: 200 });
  });

  it("scales into the view pixels of a fitted viewport", () => {
    // A 390x844 phone shown in a 300x400 pane is drawn at scale 400/844; CDP input wants view pixels.
    const fit = fitViewport({ width: 300, height: 400 }, page);
    const point = inputPoint(195, 422, page, fit.scale);
    expect(point.x).toBeCloseTo(195 * fit.scale);
    expect(point.y).toBeCloseTo(200);
  });

  it("keeps a tap inside the page and survives junk", () => {
    expect(inputPoint(-5, 99999, page, 1)).toEqual({ x: 0, y: 843 });
    expect(inputPoint(Number.NaN, Number.POSITIVE_INFINITY, page, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("FrameGate", () => {
  function setup(fps = 10) {
    const clock = fakeClock();
    const sent: number[] = [];
    const releases: (() => void)[] = [];
    const gate = new FrameGate<number>(
      (frame) =>
        new Promise<void>((resolve) => {
          sent.push(frame);
          releases.push(resolve);
        }),
      fps,
      clock,
    );
    const finish = async () => {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { clock, sent, gate, finish };
  }

  it("sends the first frame at once", () => {
    const { sent, gate } = setup();
    gate.offer(1);
    expect(sent).toEqual([1]);
  });

  it("keeps only the newest frame while a send is in flight", async () => {
    const { sent, gate, finish, clock } = setup();
    gate.offer(1);
    gate.offer(2);
    gate.offer(3);
    expect(sent).toEqual([1]);
    expect(gate.dropped).toBe(1);
    await finish();
    clock.advance(100);
    expect(sent).toEqual([1, 3]);
  });

  it("caps the rate: a frame offered right after a send waits for the interval", async () => {
    const { sent, gate, finish, clock } = setup(10); // 100 ms apart
    gate.offer(1);
    await finish();
    clock.advance(30);
    gate.offer(2);
    expect(sent).toEqual([1]);
    clock.advance(69);
    expect(sent).toEqual([1]);
    clock.advance(1);
    expect(sent).toEqual([1, 2]);
  });

  it("sends nothing after close and drops the waiting frame", async () => {
    const { sent, gate, finish, clock } = setup();
    gate.offer(1);
    gate.offer(2);
    gate.close();
    await finish();
    clock.advance(1000);
    gate.offer(3);
    expect(sent).toEqual([1]);
  });

  it("goes on after a failed send", async () => {
    const clock = fakeClock();
    const sent: number[] = [];
    const gate = new FrameGate<number>(
      async (frame) => {
        sent.push(frame);
        if (frame === 1) throw new Error("socket");
      },
      10,
      clock,
    );
    gate.offer(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(100);
    gate.offer(2);
    expect(sent).toEqual([1, 2]);
  });
});
