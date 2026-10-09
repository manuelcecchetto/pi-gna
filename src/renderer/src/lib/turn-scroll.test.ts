import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followsAfterScroll, scrollToRun, settleView, type ViewFollow } from "./turn-scroll";

// A 1000 px transcript in a 400 px view: the end is at top 600.
const at = (top: number, height = 1000, view = 400) => ({ top, height, view });

describe("followsAfterScroll", () => {
  it("follows at the end, including fractional offsets near it", () => {
    expect(followsAfterScroll(false, at(500), at(600))).toBe(true);
    expect(followsAfterScroll(false, at(500), at(598.67))).toBe(true);
  });

  it("keeps following through iOS's rubber band back up to the end", () => {
    // Pulled 40 px past the end, then bouncing back: every frame moves up, the last one lands on the end.
    let pinned = true;
    let last = at(600);
    for (const top of [620, 640, 630, 610, 600.33, 600]) {
      pinned = followsAfterScroll(pinned, last, at(top));
      last = at(top);
    }
    expect(pinned).toBe(true);
  });

  it("stops following when you scroll up off the end", () => {
    expect(followsAfterScroll(true, at(600), at(560))).toBe(false);
  });

  it("keeps following when content shrinking or the view growing moves the view up", () => {
    expect(followsAfterScroll(true, at(300, 800), at(250, 700))).toBe(true);
    expect(followsAfterScroll(true, at(300, 800, 400), at(250, 800, 450))).toBe(true);
  });

  it("does not start following when you scroll down short of the end", () => {
    expect(followsAfterScroll(false, at(300), at(400))).toBe(false);
  });
});

/** A scroller that clamps like the browser's: the content and view heights are set by the test. */
function scroller(height: number, view: number, top: number) {
  const box = { height, view, top, writes: 0 };
  return {
    box,
    get scrollHeight() {
      return box.height;
    },
    get clientHeight() {
      return box.view;
    },
    get scrollTop() {
      return box.top;
    },
    set scrollTop(value: number) {
      box.writes++;
      box.top = Math.max(0, Math.min(value, box.height - box.view));
    },
  };
}

describe("settleView", () => {
  // Positioned at the end of a 1000 px transcript in a 400 px view.
  const settled = (pinned = true): ViewFollow => ({ pinned, height: 1000, view: 400 });

  it("follows streaming growth at the end", () => {
    const element = scroller(1300, 400, 600);
    const state = settled();
    settleView(element, state, true);
    expect(element.box.top).toBe(900);
    expect(state).toEqual({ pinned: true, height: 1300, view: 400 });
  });

  it("leaves the view where it is when you are not at the end", () => {
    const element = scroller(1300, 400, 200);
    const state = settled(false);
    settleView(element, state, true);
    expect(element.box.writes).toBe(0);
    expect(state).toEqual({ pinned: false, height: 1300, view: 400 });
  });

  it("does not move the view when nothing changed size, so it never fights the send glide", () => {
    const element = scroller(1000, 400, 300);
    const state = settled();
    settleView(element, state, true);
    expect(element.box.writes).toBe(0);
    expect(state.pinned).toBe(true);
  });

  it("keeps the end in sight when the view gets shorter, even when nothing streams", () => {
    const element = scroller(1000, 250, 600);
    const state = settled();
    settleView(element, state, false);
    expect(element.box.top).toBe(750);
    expect(state).toEqual({ pinned: true, height: 1000, view: 250 });
  });

  it("does not move for a taller view, which already clamps to the end", () => {
    const element = scroller(1000, 500, 500);
    const state = settled();
    settleView(element, state, false);
    expect(element.box.writes).toBe(0);
    expect(state).toEqual({ pinned: true, height: 1000, view: 500 });
  });

  it("stops following when other growth leaves the view off the end", () => {
    const element = scroller(1300, 400, 600); // you expanded a step at the end
    const state = settled();
    settleView(element, state, false);
    expect(element.box.writes).toBe(0);
    expect(state).toEqual({ pinned: false, height: 1300, view: 400 });
  });

  it("keeps following when other growth still leaves the view at the end", () => {
    const element = scroller(1002, 400, 600);
    const state = settled();
    settleView(element, state, false);
    expect(element.box.writes).toBe(0);
    expect(state.pinned).toBe(true);
  });
});

describe("scrollToRun", () => {
  let frames: (() => void)[];
  const frame = () => frames.splice(0).forEach((callback) => callback());
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A turn at `top` in a column; it records whether the column was measuring when its offset was read. */
  const turn = (top: number) => {
    const column = { dataset: {} as DOMStringMap };
    const reads: (string | undefined)[] = [];
    const section = {
      parentElement: column as unknown as HTMLElement,
      get offsetTop() {
        reads.push(column.dataset.measuring);
        return top;
      },
    };
    return { column, reads, section };
  };
  const scroller = () => ({ calls: [] as ScrollToOptions[], scrollTo(options: ScrollToOptions) { this.calls.push(options); } });

  it("lays every turn out before reading the turn's offset, and scrolls it to the gap", () => {
    const { column, reads, section } = turn(5000);
    const root = scroller();
    scrollToRun(root as unknown as HTMLElement, section, 24, "smooth");
    expect(reads).toEqual(["1"]);
    expect(root.calls).toEqual([{ top: 4976, behavior: "smooth" }]);
    expect(column.dataset.measuring).toBe("1");
  });

  it("keeps the turns laid out through the next frame, which records their heights, then lets them skip again", () => {
    const { column, section } = turn(800);
    scrollToRun(scroller() as unknown as HTMLElement, section, 24, "instant");
    frame();
    expect(column.dataset.measuring).toBe("1");
    frame();
    expect(column.dataset.measuring).toBeUndefined();
  });

  it("leaves a later jump's mark to that jump", () => {
    const { column, section } = turn(800);
    const root = scroller() as unknown as HTMLElement;
    scrollToRun(root, section, 24, "instant");
    frame();
    scrollToRun(root, section, 24, "instant");
    expect(column.dataset.measuring).toBe("2");
    frame(); // the first jump's second frame, the later one's first
    expect(column.dataset.measuring).toBe("2");
    frame();
    expect(column.dataset.measuring).toBeUndefined();
  });
});
