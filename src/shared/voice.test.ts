import { describe, expect, it } from "vitest";
import { Endpointer, expectedSeconds, FRAME, level, readyToPlay, sentences, spoken } from "./voice";

const tone = (db: number) => {
  const amplitude = Math.sqrt(2) * 10 ** (db / 20);
  return Float32Array.from({ length: FRAME }, (_, i) => amplitude * Math.sin(i / 3));
};

/** Feeds `frames` frames at `db` and returns the edges, by frame index. */
const feed = (endpointer: Endpointer, plan: [db: number, frames: number][], boost = 0) => {
  const edges: [number, string][] = [];
  let index = 0;
  for (const [db, frames] of plan)
    for (let i = 0; i < frames; i++, index++) {
      const edge = endpointer.frame(db, boost);
      if (edge) edges.push([index, edge]);
    }
  return edges;
};

describe("level", () => {
  it("measures a frame in dBFS", () => {
    expect(level(tone(-20))).toBeCloseTo(-20, 0);
    expect(level(new Float32Array(FRAME))).toBeLessThan(-100);
  });
});

describe("Endpointer", () => {
  it("starts a turn after 160 ms of voice and ends it after 800 ms of quiet", () => {
    const edges = feed(new Endpointer(), [
      [-70, 50],
      [-25, 50],
      [-70, 60],
    ]);
    expect(edges).toEqual([
      [57, "start"],
      [139, "end"],
    ]);
  });

  it("does not start on a click, nor end on a short pause between words", () => {
    const edges = feed(new Endpointer(), [
      [-70, 50],
      [-25, 3],
      [-70, 20],
      [-25, 30],
      [-70, 20],
      [-25, 30],
      [-70, 50],
    ]);
    expect(edges.map(([, edge]) => edge)).toEqual(["start", "end"]);
  });

  it("follows a noisy room's floor, so its steady noise is not a voice", () => {
    expect(feed(new Endpointer(), [[-40, 400]])).toEqual([]);
  });

  it("needs a louder voice while the assistant plays", () => {
    expect(feed(new Endpointer(), [[-70, 50], [-45, 50]], 12)).toEqual([]);
    expect(feed(new Endpointer(), [[-70, 50], [-25, 50]], 12).map(([, edge]) => edge)).toEqual(["start"]);
  });

  it("ends a turn that runs past the longest one", () => {
    const edges = feed(new Endpointer({ startMs: 100, endMs: 800, maxMs: 2000 }), [
      [-70, 10],
      [-25, 200],
    ]);
    expect(edges.map(([, edge]) => edge)).toEqual(["start", "end", "start", "end"]);
  });
});

describe("spoken", () => {
  it("drops markdown, code, links and chat ids", () => {
    expect(spoken("**Done.** The chat `Release` (id: c3d4) pushed, see [the run](https://x.y/1) or https://ci.example/2.")).toBe(
      "Done. The chat Release pushed, see the run or a link.",
    );
    expect(spoken("1. Fix the login test\n- Release v0.29.2\n```ts\nconst x = 1\n```")).toBe("Fix the login test Release v0.29.2");
  });

  it("keeps whole sentences up to the limit", () => {
    expect(spoken("First one is here. Second one is here. Third one is long enough to go.", 40)).toBe("First one is here. Second one is here.");
    expect(spoken("one two three four five six", 12)).toBe("one two…");
  });
});

describe("sentences", () => {
  it("splits on sentence ends and joins short ones to the next", () => {
    expect(sentences("Sent. The release chat will run the tests first, then push. Anything else?")).toEqual([
      "Sent. The release chat will run the tests first, then push.",
      "Anything else?",
    ]);
    expect(sentences("no end mark")).toEqual(["no end mark"]);
  });
});

describe("readyToPlay", () => {
  it("plays at once when speech comes faster than real time", () => {
    expect(readyToPlay(0.1, 5, 1.5, false)).toBe(true);
  });

  it("waits on a slow computer until the rest will be made before the buffer runs out", () => {
    // 4 s at 0.66x real time: 1.36 s of the 2.6 s still to come is missing, so about 1.6 s must be buffered.
    expect(readyToPlay(1, 4, 0.66, false)).toBe(false);
    expect(readyToPlay(1.7, 4, 0.66, false)).toBe(true);
  });

  it("plays what there is once the sentence is done, and nothing before any audio", () => {
    expect(readyToPlay(0.4, 4, 0.5, true)).toBe(true);
    expect(readyToPlay(0, 4, 2, false)).toBe(false);
  });

  it("guesses a sentence's length from its words", () => {
    expect(expectedSeconds("one two three four five six seven eight nine ten eleven twelve thirteen")).toBeCloseTo(5.3, 1);
  });
});
