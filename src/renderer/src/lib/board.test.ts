import { describe, expect, it } from "vitest";
import { applyOp, type Board, type BoardOp, emptyBoard } from "../../../shared/board";
import type { ProjectGroup } from "../../../shared/ipc";
import { splitCardBlock, stripStudioBlocks } from "./attachments";
import type { Model } from "../../../shared/protocol";
import { boardColumns, boardProjects, cardAttention, cardSnippet, chatTitle, findSummary } from "./board";
import { cardBlock, cardNotes, draftTitle, investigatePrompt, triagePrompt } from "../../../shared/task-prompts";
import { createSession, type SessionState } from "../../../shared/session-state";
import { openChat } from "../state/app";

const ops: BoardOp[] = [
  { type: "add", id: "aaaaaa", title: "Fix the flaky login test", notes: "Fails on CI\nabout 1 in 5 runs", cwd: "/repo", before: null },
  { type: "add", id: "bbbbbb", title: "Ship dark mode", cwd: "/repo", column: "in_progress", before: null },
  { type: "add", id: "cccccc", title: "Other project", cwd: "/other", before: null },
  { type: "add", id: "dddddd", title: "Old", cwd: "/repo", column: "done", before: null },
  { type: "attach", id: "bbbbbb", chat: { path: "/s/b1.jsonl", cwd: "/repo" } },
  { type: "attach", id: "bbbbbb", chat: { path: "/s/b2.jsonl", cwd: "/repo" } },
];
const board: Board = ops.reduce((current, op, index) => applyOp(current, op, index), emptyBoard());
const card = (id: string) => board.cards.find((other) => other.id === id) ?? board.cards[0]!;
const live = (path: string, patch: Partial<SessionState>): SessionState => ({ ...createSession(path, "/repo", path), ...patch });

describe("Kanban view", () => {
  it("shows one project's cards by column", () => {
    const columns = boardColumns(board, "/repo");
    expect(Object.fromEntries(Object.entries(columns).map(([column, cards]) => [column, cards.map((c) => c.id)]))).toEqual({
      todo: ["aaaaaa"],
      in_progress: ["bbbbbb"],
      in_review: [],
      done: ["dddddd"],
    });
  });

  it("marks a card with what its open chats need", () => {
    const chats = [live("/s/b1.jsonl", { unread: "done" }), live("/s/b2.jsonl", { running: true }), live("/s/x.jsonl", { dialogs: [{} as never] })].map(openChat);
    expect(cardAttention(card("bbbbbb"), chats)).toBe("running");
    expect(cardAttention(card("bbbbbb"), chats.slice(0, 1))).toBe("unread");
    expect(cardAttention(card("bbbbbb"), [live("/s/b1.jsonl", {})].map(openChat))).toBeUndefined();
    expect(cardAttention(card("aaaaaa"), chats)).toBeUndefined();
  });

  it("names a card's chat after the open chat, else the session index, else its label on the card", () => {
    const labelled = applyOp(board, { type: "attach", id: "aaaaaa", chat: { path: "/s/a1.jsonl", cwd: "/repo", label: "On the card" } }, 11).cards.find((c) => c.id === "aaaaaa")!;
    const projects = [{ cwd: "/repo", modifiedAt: 0, sessions: [{ path: "/s/a1.jsonl", id: "a1", cwd: "/repo", title: "Indexed", named: false, createdAt: 0, modifiedAt: 0 }] }] as ProjectGroup[];
    const chats = [live("/s/a1.jsonl", { name: "Open now" })].map(openChat);
    expect(chatTitle("/s/a1.jsonl", labelled, projects, chats)).toBe("Open now");
    expect(chatTitle("/s/a1.jsonl", labelled, projects, [])).toBe("Indexed");
    expect(chatTitle("/s/a1.jsonl", labelled, [], [])).toBe("On the card");
    expect(chatTitle("/s/zz.jsonl", labelled, [], chats)).toBe("a chat");
  });

  it("shows the latest report under the title, else the notes", () => {
    expect(cardSnippet(card("aaaaaa"))).toBe("Fails on CI about 1 in 5 runs");
    const reported = applyOp(board, { type: "report", id: "aaaaaa", text: "Found it: a race in the session cookie" }, 9);
    expect(cardSnippet(reported.cards.find((c) => c.id === "aaaaaa")!)).toBe("Found it: a race in the session cookie");
    const markdown = applyOp(board, { type: "report", id: "aaaaaa", text: "Fixed on branch `pigna/aaaaaa-fix`:\n\n- **Cause:** a [race](https://e.com)" }, 10);
    expect(cardSnippet(markdown.cards.find((c) => c.id === "aaaaaa")!)).toBe("Fixed on branch pigna/aaaaaa-fix: Cause: a race");
  });

  it("lists the sidebar's projects and any other project with cards, with open cards", () => {
    const projects = [{ cwd: "/repo", modifiedAt: 0, sessions: [{ path: "/s/b1.jsonl", id: "b1", cwd: "/repo", title: "Dark mode", named: false, createdAt: 0, modifiedAt: 0 }] }] as ProjectGroup[];
    expect(boardProjects(board, projects, "/new")).toEqual([
      { cwd: "/new", open: 0 },
      { cwd: "/repo", open: 2 },
      { cwd: "/other", open: 1 },
    ]);
    expect(findSummary(projects, "/s/b1.jsonl")?.title).toBe("Dark mode");
  });


  it("keeps a card's brief out of chat titles, and shows it as a chip", () => {
    const target = card("aaaaaa");
    const investigate = investigatePrompt(target);
    const asked = `${cardBlock(target)}\n\nWhy does it only fail on CI?`;
    expect(stripStudioBlocks(asked)).toBe("Why does it only fail on CI?");
    expect(splitCardBlock(asked)).toEqual(["Why does it only fail on CI?", { id: "aaaaaa", title: "Fix the flaky login test" }]);
    expect(splitCardBlock(investigate)[0]).toMatch(/^Investigate this card[^<]*\n\nThis chat is attached to the card\./);
    expect(splitCardBlock("Why?")).toEqual(["Why?", undefined]);
  });
});

