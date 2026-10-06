import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Board } from "../shared/board";
import { BoardStore } from "./board";
import { kanbanRoute } from "./kanban";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const folder = () => mkdtemp(join(tmpdir(), "pigna-board-"));

describe("BoardStore", () => {
  it("starts empty, saves every change and broadcasts it", async () => {
    const dir = await folder();
    const pushed: Board[] = [];
    const store = new BoardStore(join(dir, "board.json"), (board) => pushed.push(board));
    expect((await store.get()).cards).toEqual([]);
    await store.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    await store.apply({ type: "add", id: "bbbbbb", title: "Two", cwd: "/repo" });
    await store.flushed();
    const saved = JSON.parse(await readFile(join(dir, "board.json"), "utf8")) as Board;
    expect(saved.cards.map((card) => card.id)).toEqual(["bbbbbb", "aaaaaa"]);
    expect(pushed).toHaveLength(2);
    expect(await readdir(dir)).toEqual(["board.json"]); // no tmp file left behind
    expect((await new BoardStore(join(dir, "board.json"), () => undefined).get()).cards).toHaveLength(2);
  });

  it("moves a file it cannot read aside instead of overwriting it", async () => {
    const dir = await folder();
    await writeFile(join(dir, "board.json"), "{ not json");
    const store = new BoardStore(join(dir, "board.json"), () => undefined);
    expect((await store.get()).cards).toEqual([]);
    const files = await readdir(dir);
    expect(files.find((file) => file.startsWith("board.corrupt-"))).toBeDefined();
    expect(files).not.toContain("board.json");
  });

  it("keeps a copy when it has to skip malformed cards", async () => {
    const dir = await folder();
    const good = { id: "aaaaaa", title: "Ok", notes: "", cwd: "/repo", column: "todo", chats: [], reports: [], createdAt: 1, updatedAt: 1 };
    await writeFile(join(dir, "board.json"), JSON.stringify({ version: 1, cards: [good, { id: "broken" }] }));
    const store = new BoardStore(join(dir, "board.json"), () => undefined);
    expect((await store.get()).cards).toEqual([{ ...good, tags: [], github: [] }]);
    const copy = (await readdir(dir)).find((file) => file.startsWith("board.corrupt-")) ?? "";
    expect(await readFile(join(dir, copy), "utf8")).toContain("broken");
  });
});

describe("BoardStore revisions", () => {
  const setup = async () => {
    const dir = await folder();
    const pushed: number[] = [];
    const store = new BoardStore(join(dir, "board.json"), (board) => pushed.push(board.rev));
    return { dir, pushed, store };
  };

  it("counts each change, pushes it with its rev and keeps it across restarts", async () => {
    const { dir, pushed, store } = await setup();
    expect((await store.get()).rev).toBe(0);
    await store.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    await store.apply({ type: "add", id: "aaaaaa", title: "Dup", cwd: "/repo" }).catch(() => undefined); // refused: no rev
    expect(await store.apply({ type: "edit", id: "aaaaaa", notes: "x" })).toMatchObject({ rev: 2 });
    expect(pushed).toEqual([1, 2]);
    await store.flushed();
    expect((await new BoardStore(join(dir, "board.json"), () => undefined).get()).rev).toBe(2);
  });

  it("loads a file from before revisions as rev 0", async () => {
    const dir = await folder();
    await writeFile(join(dir, "board.json"), JSON.stringify({ version: 1, cards: [] }));
    expect((await new BoardStore(join(dir, "board.json"), () => undefined).get()).rev).toBe(0);
  });

  it("refuses a text edit from a stale revision when that text changed since, and says the current rev", async () => {
    const { store } = await setup();
    await store.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    const seen = (await store.get()).rev;
    await store.apply({ type: "edit", id: "aaaaaa", title: "Renamed by an agent" });
    await expect(store.apply({ type: "edit", id: "aaaaaa", title: "Mine" }, seen)).rejects.toMatchObject({ code: "conflict", status: 409, detail: { rev: 2 } });
    expect((await store.get()).cards[0]?.title).toBe("Renamed by an agent");
  });

  it("lets a stale text edit through when another field or card changed", async () => {
    const { store } = await setup();
    await store.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    const seen = (await store.get()).rev;
    await store.apply({ type: "edit", id: "aaaaaa", notes: "agent notes" });
    await store.apply({ type: "add", id: "bbbbbb", title: "Two", cwd: "/repo" });
    await store.apply({ type: "edit", id: "aaaaaa", title: "Mine" }, seen);
    expect((await store.get()).cards.find((card) => card.id === "aaaaaa")).toMatchObject({ title: "Mine", notes: "agent notes" });
  });

  it("keeps structural ops last-writer-wins, whatever baseRev they carry", async () => {
    const { store } = await setup();
    await store.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    await store.apply({ type: "edit", id: "aaaaaa", title: "Two" });
    await store.apply({ type: "move", id: "aaaaaa", column: "done" }, 0);
    expect((await store.get()).cards[0]?.column).toBe("done");
  });

  it("treats a revision it no longer remembers as a conflict for text edits only", async () => {
    const { store } = await setup();
    await store.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    for (let i = 0; i < 70; i++) await store.apply({ type: "edit", id: "aaaaaa", notes: String(i) });
    await expect(store.apply({ type: "edit", id: "aaaaaa", title: "Late" }, 1)).rejects.toMatchObject({ code: "conflict" });
    await store.apply({ type: "move", id: "aaaaaa", column: "done" }, 1);
  });
});

describe("POST /kanban", () => {
  const chat = { path: "/s/chat.jsonl", cwd: "/repo" };
  const setup = async () => {
    const store = new BoardStore(join(await folder(), "board.json"), () => undefined);
    await store.apply({ type: "add", id: "aaaaaa", title: "Fix the build", notes: "CI is red", cwd: "/repo" });
    await store.apply({ type: "add", id: "cccccc", title: "Elsewhere", cwd: "/other" });
    return { store, route: kanbanRoute(store, async () => chat) };
  };
  const text = (result: unknown) => (result as { text: string }).text;

  it("lists only the chat's project", async () => {
    const { route } = await setup();
    const listed = text(await route("h", { action: "list" }));
    expect(listed).toContain("Kanban board of /repo: 1 card. This chat has no card.");
    expect(listed).toContain("- aaaaaa Fix the build\n  CI is red");
    expect(listed).not.toContain("Elsewhere");
    await expect(route("h", { action: "list", card: "cccccc" })).rejects.toThrow("No card cccccc on this project's board");
  });

  it("takes several cards, moves them and reports, attributed to the chat", async () => {
    const { store, route } = await setup();
    expect(text(await route("h", { action: "claim", card: "aaaaaa", column: "in_progress" }))).toBe("This chat now works on card aaaaaa: Fix the build (In progress).");
    await expect(route("h", { action: "claim", card: "cccccc" })).rejects.toThrow("No card cccccc");
    const created = await route("h", { action: "claim", title: "Found another bug", notes: "in the parser" });
    expect(text(created)).toContain("It also works on card aaaaaa.");
    const id = (created as { card: string }).card;
    expect(text(await route("h", { action: "list" }))).toContain(`This chat works on cards ${id}, aaaaaa.`);
    await expect(route("h", { action: "update", report: "which one?" })).rejects.toThrow(`This chat works on cards ${id}, aaaaaa. Pass card to say which one.`);
    await route("h", { action: "update", card: id, column: "in_review", report: "Fixed the parser" });
    await route("h", { action: "update", card: "aaaaaa", report: "Still red", leave: true });
    await expect(route("h", { action: "update", card: "cccccc", report: "x" })).rejects.toThrow("No card cccccc");
    const board = await store.get();
    const card = board.cards.find((other) => other.id === id);
    expect(card).toMatchObject({ cwd: "/repo", column: "in_review", chats: [{ path: chat.path, cwd: "/repo" }] });
    expect(card?.reports.at(-1)).toMatchObject({ text: "Fixed the parser", column: "in_review", chat: chat.path });
    const left = board.cards.find((other) => other.id === "aaaaaa");
    expect(left?.chats).toEqual([]);
    expect(left?.reports.at(-1)).toMatchObject({ text: "Still red", chat: chat.path });
    // With one card left, update means that card again.
    expect(text(await route("h", { action: "update", report: "done" }))).toContain(`Card ${id}`);
  });

  it("updates a card the chat is not on, by its id", async () => {
    const { store, route } = await setup();
    expect(text(await route("h", { action: "update", card: "aaaaaa", column: "done" }))).toBe("Card aaaaaa (Fix the build) is in Done.");
    expect((await store.get()).cards.find((card) => card.id === "aaaaaa")?.chats).toEqual([]);
  });

  it("renames and retags the chat's card, and shows its tags", async () => {
    const { store, route } = await setup();
    await route("h", { action: "claim", card: "aaaaaa" });
    await expect(route("h", { action: "update" })).rejects.toThrow("pass column, report, title, tags or leave");
    expect(text(await route("h", { action: "update", title: "CI fails on lint", tags: ["CI", "#lint"] }))).toBe("Card aaaaaa (CI fails on lint) is in To do. Tags: ci, lint.");
    expect((await store.get()).cards.find((card) => card.id === "aaaaaa")?.reports).toEqual([]);
    expect(text(await route("h", { action: "list" }))).toContain("- aaaaaa CI fails on lint #ci #lint  (this chat's card, 1 chat)");
    expect(text(await route("h", { action: "list", card: "aaaaaa" }))).toContain("Tags: ci, lint");
    await expect(route("h", { action: "update", tags: ["x".repeat(40)] })).rejects.toThrow("too long");
  });

  it("asks the chat to take a card before updating one", async () => {
    const { route } = await setup();
    await expect(route("h", { action: "update", report: "done" })).rejects.toThrow("This chat has no card. Pass card");
    await expect(route("h", { action: "update", column: "later" })).rejects.toThrow("unknown column later");
    await expect(route("h", { action: "drop" })).rejects.toThrow("unknown action drop");
  });
});
