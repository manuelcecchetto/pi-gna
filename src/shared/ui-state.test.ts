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

describe("pinned chats", () => {
  it("pins a session file once and unpins it", () => {
    const state = run([{ type: "pinChat", session: "/s/a.jsonl" }, { type: "pinChat", session: "/s/b.jsonl" }, { type: "pinChat", session: "/s/a.jsonl" }]);
    expect(state.chats).toEqual(["/s/a.jsonl", "/s/b.jsonl"]);
    expect(applyUiOp(state, { type: "unpinChat", session: "/s/a.jsonl" }).chats).toEqual(["/s/b.jsonl"]);
    expect(applyUiOp(state, { type: "unpinChat", session: "/zzz" })).toBe(state);
  });
  it("rejects a chat that is not a session file path", () => {
    expect(() => applyUiOp(emptyUiState(), { type: "pinChat", session: "rel.jsonl" })).toThrow("session file");
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

describe("pinned models", () => {
  it("pins below the existing ones, ignores repeats and unpins", () => {
    const state = run([{ type: "pinModel", model: "openai/gpt-5.5" }, { type: "pinModel", model: "anthropic/claude-opus-5-5" }, { type: "pinModel", model: "openai/gpt-5.5" }]);
    expect(state.models).toEqual(["openai/gpt-5.5", "anthropic/claude-opus-5-5"]);
    expect(applyUiOp(state, { type: "pinModel", model: "openai/gpt-5.5" })).toBe(state);
    expect(applyUiOp(state, { type: "unpinModel", model: "openai/gpt-5.5" }).models).toEqual(["anthropic/claude-opus-5-5"]);
    expect(applyUiOp(state, { type: "unpinModel", model: "x/y" })).toBe(state);
  });
  it("rejects a key that is not provider/id", () => {
    for (const model of ["gpt-5.5", "/gpt", "openai/", "a b/c", ""]) expect(() => applyUiOp(emptyUiState(), { type: "pinModel", model })).toThrow("provider/id");
  });
  it("refuses a change it does not know", () => {
    expect(() => applyUiOp(emptyUiState(), { type: "later" } as unknown as UiOp)).toThrow("Unknown");
  });
});

describe("parseUiState", () => {
  it("keeps well-formed entries and counts the rest", () => {
    const { value, dropped } = parseUiState({ pins: ["/a", "/a", 3, "rel"], chats: ["/s/a.jsonl", "/s/a.jsonl", "rel"], bookmarks: { "/s": [1, "x", 1, 2], rel: [1], "/t": [] } });
    expect(value).toEqual({ pins: ["/a"], hidden: [], chats: ["/s/a.jsonl"], bookmarks: { "/s": [1, 2] }, models: [] });
    expect(dropped).toBe(7);
  });
  it("keeps pinned models keyed provider/id, and reads a file from before them", () => {
    const { value, dropped } = parseUiState({ models: ["openai/gpt-5.5", "openai/gpt-5.5", "openrouter/anthropic/claude-x", "gpt-5.5", "/x", 4] });
    expect(value.models).toEqual(["openai/gpt-5.5", "openrouter/anthropic/claude-x"]);
    expect(dropped).toBe(4);
    expect(parseUiState({ pins: ["/a"] }).value.models).toEqual([]);
  });
  it("starts empty for anything else", () => {
    expect(parseUiState(null).value).toEqual(emptyUiState());
  });
});
