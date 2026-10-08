import { describe, expect, it } from "vitest";
import { shallow } from "./store";

describe("shallow", () => {
  const a = { x: 1 };
  const b = { x: 1 };

  it("compares arrays and objects one level deep, by reference", () => {
    expect(shallow([a, b], [a, b])).toBe(true);
    expect(shallow({ one: a, two: "t" }, { one: a, two: "t" })).toBe(true);
    expect(shallow([a], [b])).toBe(false);
    expect(shallow({ one: a }, { one: b })).toBe(false);
  });

  it("tells apart different lengths, keys and shapes", () => {
    expect(shallow([a], [a, a])).toBe(false);
    expect(shallow<Record<string, unknown>>({ one: a }, { two: a })).toBe(false);
    expect(shallow<unknown>([a], { 0: a })).toBe(false);
    expect(shallow<unknown>(null, {})).toBe(false);
    expect(shallow(NaN, NaN)).toBe(true);
  });
});
