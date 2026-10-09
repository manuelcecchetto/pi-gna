import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMessage } from "../../../shared/protocol";
import { createSession, type Item } from "../../../shared/session-state";
import { turnLabel } from "../../../shared/turn-outline";
import { adjacentTurn, nearDistance, outlineItems, pagePreview, railItems, railPreview, sameMarkers } from "./rail";
import { type Block, layoutRun, type Run } from "./view";

// Pass-through spies: they count the label and layout work the rail does.
vi.mock("./view", async (original) => {
  const actual = await original<typeof import("./view")>();
  return { ...actual, layoutRun: vi.fn(actual.layoutRun) };
});
vi.mock("../../../shared/turn-outline", async (original) => {
  const actual = await original<typeof import("../../../shared/turn-outline")>();
  return { ...actual, turnLabel: vi.fn(actual.turnLabel) };
});

beforeEach(() => {
  vi.mocked(layoutRun).mockClear();
  vi.mocked(turnLabel).mockClear();
});

const user = (content: UserMessage["content"], timestamp = 1): Run["user"] => ({ key: `u${timestamp}`, message: { role: "user", content, timestamp } });
const text = (key: string, value: string, stopReason: "stop" | "toolUse" = "stop"): Block => ({ kind: "text", key, text: value, streaming: false, at: 2, stopReason });
const activity: Block = { kind: "activity", key: "group:a", steps: [], live: false, at: 2 };

describe("railItems", () => {
  it("previews the final answer, not commentary before the last tool step", () => {
    const run: Run = { key: "r1", user: user("fix auth"), live: false, blocks: [text("t1", "Let me check"), activity, text("t2", "Fixed **auth**."), text("t3", "Tests pass.")] };
    const [item] = railItems([run]);
    expect(item).toEqual({ key: "r1", at: 1, label: "fix auth", run, live: false });
    expect(item && railPreview(item)).toBe("Fixed **auth**.\n\nTests pass.");
  });

  it("puts the message on one line without pi-gna's file and comment blocks", () => {
    const message = "look at\n\nthese   files\n\n# Files mentioned by the user:\n\n## a.ts: /repo/a.ts\n\n<browser-comments>\n1. too big\n</browser-comments>";
    expect(railItems([{ key: "r1", user: user(message), live: false, blocks: [] }])[0]?.label).toBe("look at these files");
    expect(railItems([{ key: "r2", user: user("# Files mentioned by the user:\n\n## a.ts: /repo/a.ts"), live: false, blocks: [] }])[0]?.label).toBe("a.ts");
    const image = { type: "image" as const, data: "", mimeType: "image/png" };
    expect(railItems([{ key: "r3", user: user([image, image]), live: false, blocks: [] }])[0]?.label).toBe("2 images");
  });

  it("skips runs without a message and previews errors and interruptions", () => {
    const runs: Run[] = [
      { key: "empty", live: false, blocks: [{ kind: "notice", key: "n", level: "info", text: "hi" }] },
      { key: "r1", user: user("go"), live: false, blocks: [{ kind: "error", key: "e", text: "rate limited" }] },
      { key: "r2", user: user("again", 2), live: false, blocks: [activity, { kind: "aborted", key: "a" }] },
    ];
    expect(railItems(runs).map((item) => [item.key, railPreview(item)])).toEqual([
      ["r1", "rate limited"],
      ["r2", "*Interrupted*"],
    ]);
  });

  it("reuses items of unchanged runs", () => {
    const run: Run = { key: "r1", user: user("go"), live: false, blocks: [] };
    expect(railItems([run])[0]).toBe(railItems([run])[0]);
  });

  it("builds no preview while a turn streams, and the message's label once", () => {
    const first: Run = { key: "r1", user: user("go"), live: true, blocks: [text("t1", "Wor")] };
    const next: Run = { ...first, blocks: [text("t1", "Working")] };
    const [a] = railItems([first]);
    const [b] = railItems([next]);
    expect(b).not.toBe(a);
    expect(b).toMatchObject({ key: "r1", label: "go", live: true, run: next });
    expect(turnLabel).toHaveBeenCalledTimes(1);
    expect(layoutRun).not.toHaveBeenCalled();
    // The card asks: built once per turn object.
    expect(b && railPreview(b)).toBe("Working");
    expect(b && railPreview(b)).toBe("Working");
    expect(a && railPreview(a)).toBe("Wor");
    expect(layoutRun).toHaveBeenCalledTimes(2);
  });
});

describe("turns the client has not loaded", () => {
  it("are markers from the outline, the same items each time, whose preview comes from the host", async () => {
    const outline = [{ key: "i0", at: 5, label: "first" }, { key: "i3", at: 9, label: "second" }];
    const asked: number[] = [];
    const items = outlineItems(outline, async (index) => (asked.push(index), `answer ${index}`));
    expect(items.map((item) => ({ key: item.key, at: item.at, label: item.label, preview: railPreview(item), live: item.live }))).toEqual([
      { key: "i0", at: 5, label: "first", preview: "", live: false },
      { key: "i3", at: 9, label: "second", preview: "", live: false },
    ]);
    expect(outlineItems(outline)).toBe(items);
    expect(await items[1]!.loadPreview!()).toBe("answer 1");
    expect(asked).toEqual([1]);
  });

  it("previews the turn a one-turn page holds as a loaded turn's card would", () => {
    const items: Item[] = [
      { kind: "user", key: "i4", message: { role: "user", content: "go", timestamp: 1 } },
      { kind: "assistant", key: "i5", streaming: false, message: { role: "assistant", content: [{ type: "text", text: "Let me look" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 2 } as never },
      { kind: "assistant", key: "i6", streaming: false, message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 3 } as never },
    ];
    expect(pagePreview({ ...createSession("h", "/p"), items })).toBe("Done.");
    expect(pagePreview({ ...createSession("h", "/p"), items: [] })).toBe("");
  });
});

describe("sameMarkers", () => {
  it("ignores a new item for the same turn and notices any other change", () => {
    const runs: Run[] = [1, 2, 3].map((at) => ({ key: `r${at}`, user: user(`m${at}`, at), live: false, blocks: [] }));
    const rail = railItems(runs);
    const streamed = railItems([...runs.slice(0, 2), { ...runs[2]!, live: true, blocks: [text("t", "more")] }]);
    expect(streamed[2]).not.toBe(rail[2]);
    expect(sameMarkers(rail, streamed)).toBe(true);
    expect(sameMarkers(rail, rail.slice(0, 2))).toBe(false);
    expect(sameMarkers(rail, [...rail.slice(0, 2), { ...rail[2]!, key: "r9" }])).toBe(false);
    expect(sameMarkers(rail, [...rail.slice(0, 2), { ...rail[2]!, at: 9 }])).toBe(false);
  });
});

describe("nearDistance", () => {
  it("magnifies three neighbours on each side of the hot marker", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => nearDistance(index, 4))).toEqual([undefined, 3, 2, 1, 0, 1, 2, 3, undefined]);
    expect(nearDistance(2, null)).toBeUndefined();
  });
});

describe("adjacentTurn", () => {
  // Distances of each message below the jump position; null = on an earlier, unrendered page.
  it("goes down to the first message below the top", () => {
    expect(adjacentTurn([-900, -300, 10, 400, 900], "next")).toBe(3);
    expect(adjacentTurn([-900, -300, -10], "next")).toBeUndefined();
  });

  it("goes up to the start of the turn you are reading, or the one before when already there", () => {
    expect(adjacentTurn([-900, -300, 400], "previous")).toBe(1);
    expect(adjacentTurn([-900, 5, 400], "previous")).toBe(0);
    expect(adjacentTurn([3, 400], "previous")).toBeUndefined();
  });

  it("reaches into earlier pages", () => {
    expect(adjacentTurn([null, null, 0, 600], "previous")).toBe(1);
    expect(adjacentTurn([null, 200, 600], "previous")).toBe(0);
  });
});
