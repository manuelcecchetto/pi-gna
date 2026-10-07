import { describe, expect, it } from "vitest";
import type { Card } from "../shared/board";
import { attachmentCount, cardMark, cardTasks, dropOp, indexAt, moveToOp } from "./board-data";

const card = (id: string, column: Card["column"] = "todo", extra: Partial<Card> = {}): Card => ({ id, title: id, notes: "", tags: [], cwd: "/p", column, github: [], chats: [], reports: [], createdAt: 1, updatedAt: 1, ...extra });

describe("cardTasks", () => {
  it("offers what the desktop's card actions offer per column", () => {
    const ids = (c: Card) => cardTasks(c).map((t) => t.id);
    expect(ids(card("a", "todo"))).toEqual(["investigate", "resolve", "discuss"]);
    expect(ids(card("a", "in_review"))).toEqual(["investigate", "resolve", "qa", "discuss"]);
    expect(ids(card("a", "done"))).toEqual(["investigate", "discuss"]);
  });
});

describe("dropOp", () => {
  const column = [card("a"), card("b"), card("c")];
  it("drops before the card now at the place, or at the bottom", () => {
    expect(dropOp(column, "a", 1)).toEqual({ type: "move", id: "a", column: "todo", before: "c" });
    expect(dropOp(column, "a", 2)).toEqual({ type: "move", id: "a", column: "todo", before: null });
    expect(dropOp(column, "c", 0)).toEqual({ type: "move", id: "c", column: "todo", before: "a" });
  });
  it("does nothing when the card lands where it was", () => {
    expect(dropOp(column, "b", 1)).toBeUndefined();
    expect(dropOp(column, "x", 0)).toBeUndefined();
  });
});

describe("moveToOp", () => {
  it("moves to another column only", () => {
    expect(moveToOp(card("a"), "done")).toEqual({ type: "move", id: "a", column: "done" });
    expect(moveToOp(card("a"), "todo")).toBeUndefined();
  });
});

describe("indexAt", () => {
  it("counts the rows whose middle is above the finger", () => {
    expect(indexAt([10, 30, 50], 5)).toBe(0);
    expect(indexAt([10, 30, 50], 35)).toBe(2);
    expect(indexAt([10, 30, 50], 99)).toBe(3);
  });
});

describe("attachmentCount and cardMark", () => {
  it("counts the notes' attachment list", () => {
    expect(attachmentCount(card("a", "todo", { notes: "x\n\nAttachments:\n- /a.png\n- /b.png" }))).toBe(2);
    expect(attachmentCount(card("a"))).toBe(0);
  });
  it("takes the strongest mark of the card's open chats", () => {
    const c = card("a", "todo", { chats: [{ path: "/s1", cwd: "/p", at: 1 }, { path: "/s2", cwd: "/p", at: 1 }] });
    const s = (handle: string, path: string, attention: "running" | "failed" | "idle") => ({ handle, cwd: "/p", sessionPath: path, title: "", listed: true, attention, running: false, dialogs: 0 });
    expect(cardMark(c, { h1: s("h1", "/s1", "running"), h2: s("h2", "/s2", "failed"), h3: s("h3", "/other", "running") })).toBe("running");
    expect(cardMark(c, {})).toBeUndefined();
  });
});
