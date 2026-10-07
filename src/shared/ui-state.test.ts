import { describe, expect, it } from "vitest";
import { applyUiOp, emptyUiState, parseUiState, type UiOp } from "./ui-state";

const run = (ops: UiOp[]) => ops.reduce(applyUiOp, emptyUiState());

describe("pins", () => {
  it("pins below the existing ones and ignores repeats", () => {
    const state = run([{ type: "pin", cwd: "/a" }, { type: "pin", cwd: "/b" }, { type: "pin", cwd: "/a" }]);
    expect(state.pins).toEqual(["/a", "/b"]);
    expect(applyUiOp(state, { type: "pin", cwd: "/a" })).toBe(state);
  });
  it("unpins and reorders", () => {
    let state = run([{ type: "pin", cwd: "/a" }, { type: "pin", cwd: "/b" }, { type: "pin", cwd: "/c" }]);
    state = applyUiOp(state, { type: "reorder", cwd: "/c", index: 0 });
    expect(state.pins).toEqual(["/c", "/a", "/b"]);
    expect(applyUiOp(state, { type: "unpin", cwd: "/a" }).pins).toEqual(["/c", "/b"]);
    expect(applyUiOp(state, { type: "unpin", cwd: "/zzz" })).toBe(state);
  });
  it("rejects bad pins and reorders", () => {
    expect(() => applyUiOp(emptyUiState(), { type: "pin", cwd: "rel" })).toThrow();
    expect(() => applyUiOp(emptyUiState(), { type: "reorder", cwd: "/a", index: 0 })).toThrow("not pinned");
    const state = run([{ type: "pin", cwd: "/a" }]);
    expect(() => applyUiOp(state, { type: "reorder", cwd: "/a", index: 1 })).toThrow("out of range");
  });
});

describe("hidden projects", () => {
  it("hides once, unpinning, and unhides", () => {
    const state = run([{ type: "pin", cwd: "/a" }, { type: "pin", cwd: "/b" }, { type: "hide", cwd: "/a" }]);
    expect(state).toMatchObject({ pins: ["/b"], hidden: ["/a"] });
    expect(applyUiOp(state, { type: "hide", cwd: "/a" })).toBe(state);
    expect(applyUiOp(state, { type: "unhide", cwd: "/a" }).hidden).toEqual([]);
    expect(applyUiOp(state, { type: "unhide", cwd: "/zzz" })).toBe(state);
  });
  it("rejects a relative path and pinning a hidden project", () => {
    expect(() => applyUiOp(emptyUiState(), { type: "hide", cwd: "rel" })).toThrow();
    expect(() => run([{ type: "hide", cwd: "/a" }, { type: "pin", cwd: "/a" }])).toThrow("hidden");
  });
});

describe("bookmarks", () => {
  it("adds per session by message time and removes the entry with its last turn", () => {
    let state = run([{ type: "bookmark", session: "/s.jsonl", at: 5 }, { type: "bookmark", session: "/s.jsonl", at: 9 }, { type: "bookmark", session: "/s.jsonl", at: 5 }]);
    expect(state.bookmarks).toEqual({ "/s.jsonl": [5, 9] });
    state = applyUiOp(state, { type: "unbookmark", session: "/s.jsonl", at: 5 });
    state = applyUiOp(state, { type: "unbookmark", session: "/s.jsonl", at: 9 });
    expect(state.bookmarks).toEqual({});
    expect(applyUiOp(state, { type: "unbookmark", session: "/s.jsonl", at: 9 })).toBe(state);
  });
  it("rejects a malformed bookmark", () => {
    expect(() => applyUiOp(emptyUiState(), { type: "bookmark", session: "/s", at: Number.NaN })).toThrow();
  });
});

describe("parseUiState", () => {
  it("keeps well-formed entries and counts the rest", () => {
    const { value, dropped } = parseUiState({ pins: ["/a", "/a", 3, "rel"], bookmarks: { "/s": [1, "x", 1, 2], rel: [1], "/t": [] } });
    expect(value).toEqual({ pins: ["/a"], hidden: [], bookmarks: { "/s": [1, 2] } });
    expect(dropped).toBe(5);
  });
  it("starts empty for anything else", () => {
    expect(parseUiState(null).value).toEqual(emptyUiState());
  });
});
