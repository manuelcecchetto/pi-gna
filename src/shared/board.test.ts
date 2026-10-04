import { describe, expect, it } from "vitest";
import { applyOp, type Board, BoardError, type BoardOp, boardConflict, type Column, cardOfChat, emptyBoard, freshId, LIMITS, parseBoard, projectOf, worktreeCwd } from "./board";

const run = (ops: BoardOp[], board = emptyBoard()) => ops.reduce((current, op, index) => applyOp(current, op, 1000 + index), board);
const add = (id: string, column: Column = "todo"): Extract<BoardOp, { type: "add" }> => ({
  type: "add",
  id,
  title: `Card ${id}`,
  cwd: "/repo",
  column,
  before: null,
});
const order = (board: Board, column = "todo") => board.cards.filter((card) => card.column === column).map((card) => card.id);

describe("board ops", () => {
  it("adds cards at the top by default, at the bottom with before: null, or before a card", () => {
    let board = run([add("aaaaaa"), add("bbbbbb")]);
    expect(order(board)).toEqual(["aaaaaa", "bbbbbb"]);
    board = applyOp(board, { type: "add", id: "cccccc", title: "  spaced \n title ", cwd: "/repo" }, 5);
    expect(order(board)).toEqual(["cccccc", "aaaaaa", "bbbbbb"]);
    expect(board.cards[0]).toMatchObject({ title: "spaced title", notes: "", column: "todo", chats: [], reports: [], createdAt: 5 });
    board = applyOp(board, { ...add("dddddd"), before: "bbbbbb" }, 6);
    expect(order(board)).toEqual(["cccccc", "aaaaaa", "dddddd", "bbbbbb"]);
  });

  it("gives new cards a fresh six-character id", () => {
    const board = applyOp(emptyBoard(), { type: "add", title: "x", cwd: "/repo" }, 1);
    expect(board.cards[0]?.id).toMatch(/^[a-z0-9]{6}$/);
    let calls = 0;
    expect(freshId(board, () => (calls++ === 0 ? parseInt(board.cards[0]?.id ?? "", 36) / 36 ** 6 : 0))).toBe("000000");
  });

  it("rejects bad input from the renderer or an agent", () => {
    const board = run([add("aaaaaa")]);
    const bad: unknown[] = [
      { type: "add", title: "   ", cwd: "/repo" },
      { type: "add", title: "x".repeat(LIMITS.title + 1), cwd: "/repo" },
      { type: "add", title: "x", cwd: "relative" },
      { type: "add", id: "aaaaaa", title: "dup", cwd: "/repo" },
      { type: "add", id: "../etc", title: "x", cwd: "/repo" },
      { type: "add", title: "x", cwd: "/repo", column: "later" },
      { type: "edit", id: "aaaaaa", notes: "n".repeat(LIMITS.notes + 1) },
      { type: "move", id: "nope", column: "done" },
      { type: "report", id: "aaaaaa", text: "r".repeat(LIMITS.report + 1) },
      { type: "report", id: "aaaaaa", text: 42 },
      { type: "attach", id: "aaaaaa", chat: { path: "x.jsonl", cwd: "/repo" } },
      { type: "attach", id: "aaaaaa", chat: { path: "/s/x.jsonl", cwd: "/other-project" } },
      { type: "drop-table" },
      null,
    ];
    for (const op of bad) expect(() => applyOp(board, op as BoardOp, 1), JSON.stringify(op)).toThrow(BoardError);
  });

  it("moves a card to the top of another column, or just before a card", () => {
    let board = run([add("aaaaaa"), add("bbbbbb"), add("cccccc", "done"), add("dddddd", "done")]);
    board = applyOp(board, { type: "move", id: "aaaaaa", column: "done" }, 50);
    expect(order(board, "done")).toEqual(["aaaaaa", "cccccc", "dddddd"]);
    expect(board.cards.find((card) => card.id === "aaaaaa")?.updatedAt).toBe(50);
    board = applyOp(board, { type: "move", id: "aaaaaa", column: "done", before: "dddddd" }, 51);
    expect(order(board, "done")).toEqual(["cccccc", "aaaaaa", "dddddd"]);
    board = applyOp(board, { type: "move", id: "cccccc", column: "done", before: null }, 52);
    expect(order(board, "done")).toEqual(["aaaaaa", "dddddd", "cccccc"]);
    expect(order(board)).toEqual(["bbbbbb"]);
    // Dropping a card onto itself changes nothing.
    expect(applyOp(board, { type: "move", id: "aaaaaa", column: "done", before: "aaaaaa" }, 53)).toBe(board);
  });

  it("keeps a chat on one card at a time", () => {
    const chat = { path: "/s/one.jsonl", cwd: "/repo", label: "  Fix\nthe build " };
    let board = run([add("aaaaaa"), add("bbbbbb"), { type: "attach", id: "aaaaaa", chat }]);
    expect(board.cards[0]?.chats).toEqual([{ path: "/s/one.jsonl", cwd: "/repo", label: "Fix the build", at: 1002 }]);
    expect(applyOp(board, { type: "attach", id: "aaaaaa", chat }, 9)).toBe(board);
    board = applyOp(board, { type: "attach", id: "bbbbbb", chat }, 10);
    expect(board.cards.map((card) => card.chats.length)).toEqual([0, 1]);
    expect(cardOfChat(board, "/s/one.jsonl")?.id).toBe("bbbbbb");
    board = applyOp(board, { type: "detach", id: "bbbbbb", path: "/s/one.jsonl" }, 11);
    expect(cardOfChat(board, "/s/one.jsonl")).toBeUndefined();
  });

  it("takes a chat from the card's worktree as one of its project", () => {
    const board = run([add("aaaaaa")]);
    const inWorktree = { path: "/s/w.jsonl", cwd: worktreeCwd("/home/me", "aaaaaa", "/repo") };
    expect(applyOp(board, { type: "attach", id: "aaaaaa", chat: inWorktree }, 5).cards[0]?.chats).toEqual([{ ...inWorktree, at: 5 }]);
    const elsewhere = { path: "/s/o.jsonl", cwd: worktreeCwd("/home/me", "aaaaaa", "/other") };
    expect(() => applyOp(board, { type: "attach", id: "aaaaaa", chat: elsewhere }, 5)).toThrow(BoardError);
  });

  it("records reports, moves the card with a report, and keeps the latest reports", () => {
    let board = run([add("aaaaaa"), add("bbbbbb")]);
    board = applyOp(board, { type: "report", id: "bbbbbb", text: " found the cause ", chat: "/s/one.jsonl" }, 20);
    board = applyOp(board, { type: "report", id: "bbbbbb", text: "fixed", column: "in_review" }, 21);
    const card = board.cards.find((other) => other.id === "bbbbbb");
    expect(card?.column).toBe("in_review");
    expect(card?.reports).toEqual([
      { at: 20, text: "found the cause", chat: "/s/one.jsonl" },
      { at: 21, text: "fixed", column: "in_review" },
    ]);
    // A report that neither says anything nor moves the card is dropped.
    expect(applyOp(board, { type: "report", id: "bbbbbb", text: "  ", column: "in_review" }, 22)).toBe(board);
    for (let i = 0; i < LIMITS.reports + 5; i++) board = applyOp(board, { type: "report", id: "aaaaaa", text: `r${i}` }, 30 + i);
    const reports = board.cards.find((other) => other.id === "aaaaaa")?.reports ?? [];
    expect(reports).toHaveLength(LIMITS.reports);
    expect(reports.at(-1)?.text).toBe(`r${LIMITS.reports + 4}`);
  });

  it("spells tags one way and caps them", () => {
    let board = run([{ ...add("aaaaaa"), tags: ["UI"] }]);
    expect(board.cards[0]?.tags).toEqual(["ui"]);
    board = applyOp(board, { type: "edit", id: "aaaaaa", tags: [" #Kanban ", "UI Bug", "ui-bug", "", "ui"] }, 5);
    expect(board.cards[0]).toMatchObject({ tags: ["kanban", "ui-bug", "ui"], title: "Card aaaaaa", updatedAt: 5 });
    expect(applyOp(board, { type: "edit", id: "aaaaaa", title: "Renamed" }, 6).cards[0]?.tags).toEqual(["kanban", "ui-bug", "ui"]);
    const tooMany = Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`);
    for (const tags of [tooMany, ["x".repeat(LIMITS.tag + 1)], [42], "ui"]) {
      expect(() => applyOp(board, { type: "edit", id: "aaaaaa", tags } as BoardOp, 7), JSON.stringify(tags)).toThrow(BoardError);
    }
  });

  it("links issues and pull requests, once each, and checks them", () => {
    const issue = { kind: "issue" as const, host: "GitHub.com", repo: "acme/tool", number: 12, url: "https://github.com/acme/tool/issues/12", title: " Crash\n on start " };
    let board = run([{ ...add("aaaaaa"), github: [issue, issue] }]);
    expect(board.cards[0]?.github).toEqual([{ ...issue, host: "github.com", title: "Crash on start" }]);
    const pr = { kind: "pr" as const, host: "github.com", repo: "acme/tool", number: 13, url: "https://github.com/acme/tool/pull/13", title: "Fix the crash" };
    board = applyOp(board, { type: "link", id: "aaaaaa", github: pr }, 5);
    expect(board.cards[0]).toMatchObject({ github: [{ number: 12 }, { number: 13 }], updatedAt: 5 });
    expect(applyOp(board, { type: "link", id: "aaaaaa", github: pr }, 6)).toBe(board);
    // Linked again: the new title.
    board = applyOp(board, { type: "link", id: "aaaaaa", github: { ...pr, title: "Fix the crash on start" } }, 7);
    expect(board.cards[0]?.github.map((ref) => ref.title)).toEqual(["Crash on start", "Fix the crash on start"]);
    board = applyOp(board, { type: "unlink", id: "aaaaaa", github: { host: "github.com", repo: "Acme/Tool", number: 12 } }, 8);
    expect(board.cards[0]?.github.map((ref) => ref.number)).toEqual([13]);
    expect(applyOp(board, { type: "unlink", id: "aaaaaa", github: { host: "github.com", repo: "acme/tool", number: 99 } }, 9)).toBe(board);
    const bad: unknown[] = [
      { ...pr, kind: "discussion" },
      { ...pr, host: "not a host" },
      { ...pr, repo: "acme" },
      { ...pr, number: 0 },
      { ...pr, number: 1.5 },
      { ...pr, url: "javascript:alert(1)" },
      { ...pr, url: "https://evil.example/acme/tool/pull/13" },
      { ...pr, title: "t".repeat(LIMITS.title + 1) },
      null,
    ];
    for (const github of bad) expect(() => applyOp(board, { type: "link", id: "aaaaaa", github } as BoardOp, 10), JSON.stringify(github)).toThrow(BoardError);
    for (let number = 100; board.cards[0] && board.cards[0].github.length < LIMITS.github; number++) board = applyOp(board, { type: "link", id: "aaaaaa", github: { ...pr, number } }, 11);
    expect(() => applyOp(board, { type: "link", id: "aaaaaa", github: { ...pr, number: 999 } }, 12)).toThrow(BoardError);
  });

  it("removes cards", () => {
    const board = run([add("aaaaaa"), add("bbbbbb"), { type: "remove", id: "aaaaaa" }]);
    expect(board.cards.map((card) => card.id)).toEqual(["bbbbbb"]);
  });
});

describe("parseBoard", () => {
  it("keeps well-formed cards and counts the rest", () => {
    const good = run([add("aaaaaa")]).cards[0];
    expect(parseBoard({ version: 1, cards: [good, { id: "x" }, null] })).toEqual({ board: { version: 1, cards: [good] }, dropped: 2 });
    expect(() => parseBoard({ cards: "nope" })).toThrow(BoardError);
    // Cards saved before tags existed.
    const { tags: _, ...old } = good ?? { tags: [] };
    expect(parseBoard({ cards: [old, { ...old, id: "bbbbbb", tags: [1] }] })).toEqual({ board: { version: 1, cards: [{ ...old, tags: [] }] }, dropped: 1 });
    // And before GitHub links.
    const { github: __, ...unlinked } = good ?? { github: [] };
    expect(parseBoard({ cards: [unlinked, { ...unlinked, id: "bbbbbb", github: [{ kind: "issue" }] }] })).toEqual({ board: { version: 1, cards: [{ ...unlinked, github: [] }] }, dropped: 1 });
  });
});

describe("card worktrees", () => {
  it("mirror the project's path under the card's folder, and map back to it", () => {
    const cwd = worktreeCwd("/Users/me/", "abc123", "/Users/me/Code/app");
    expect(cwd).toBe("/Users/me/.pi-gna/worktrees/abc123/Users/me/Code/app");
    expect(projectOf(cwd)).toBe("/Users/me/Code/app");
    expect(projectOf("/Users/me/Code/app")).toBe("/Users/me/Code/app");
    // Only a card's folder holds a worktree; anything else in there is a project of its own.
    for (const other of ["/Users/me/.pi-gna/worktrees/abc123", "/Users/me/.pi-gna/worktrees/notes/x", "/Users/me/.pi-gna/worktrees//x"]) {
      expect(projectOf(other)).toBe(other);
    }
  });
});

describe("boardConflict", () => {
  const card = (over: object = {}) => ({ id: "aaaaaa", title: "One", notes: "n", tags: ["a"], cwd: "/repo", column: "todo", github: [], chats: [], reports: [], createdAt: 1, updatedAt: 1, ...over }) as Board["cards"][number];
  const board = (...cards: Board["cards"]): Board => ({ version: 1, cards });

  it("flags a text field replaced after it changed, and only that field", () => {
    const base = board(card());
    const now = board(card({ title: "Agent", tags: ["b"] }));
    expect(boardConflict(base, now, { type: "edit", id: "aaaaaa", title: "Mine" })).toBe(true);
    expect(boardConflict(base, now, { type: "edit", id: "aaaaaa", tags: ["c"] })).toBe(true);
    expect(boardConflict(base, now, { type: "edit", id: "aaaaaa", notes: "Mine" })).toBe(false);
  });

  it("never flags structural ops, and treats an unknown base as stale for text edits", () => {
    const now = board(card({ title: "Agent", column: "done" }));
    expect(boardConflict(board(card()), now, { type: "move", id: "aaaaaa", column: "todo" })).toBe(false);
    expect(boardConflict(undefined, now, { type: "attach", id: "aaaaaa", chat: { path: "/s", cwd: "/repo" } })).toBe(false);
    expect(boardConflict(undefined, now, { type: "edit", id: "aaaaaa", title: "Mine" })).toBe(true);
    expect(boardConflict(board(), now, { type: "edit", id: "aaaaaa", title: "Mine" })).toBe(false);
  });
});
