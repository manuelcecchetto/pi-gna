import { describe, expect, it } from "vitest";
import { followsAfterScroll } from "./turn-scroll";

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
