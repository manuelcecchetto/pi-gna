import { describe, expect, it } from "vitest";
import { applyOp, type Board, type BoardOp, emptyBoard } from "../../../shared/board";
import type { ProjectGroup } from "../../../shared/ipc";
import { splitCardBlock, stripStudioBlocks } from "./attachments";
import type { Model } from "../../../shared/protocol";
import {
  boardColumns,
  boardProjects,
  boardTags,
  cardAttention,
  cardBlock,
  cardNotes,
  cardSnippet,
  draftTitle,
  findSummary,
  hasWorktree,
  investigatePrompt,
  pickModel,
  qaPrompt,
  resolvePrompt,
  splitAttachments,
  triagePrompt,
} from "./board";
import { createSession, type SessionState } from "./session";

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
    const sessions = [live("/s/b1.jsonl", { unread: "done" }), live("/s/b2.jsonl", { running: true }), live("/s/x.jsonl", { dialogs: [{} as never] })];
    expect(cardAttention(card("bbbbbb"), sessions)).toBe("running");
    expect(cardAttention(card("aaaaaa"), sessions)).toBeUndefined();
  });

  it("shows the latest report under the title, else the notes", () => {
    expect(cardSnippet(card("aaaaaa"))).toBe("Fails on CI about 1 in 5 runs");
    const reported = applyOp(board, { type: "report", id: "aaaaaa", text: "Found it: a race in the session cookie" }, 9);
    expect(cardSnippet(reported.cards.find((c) => c.id === "aaaaaa")!)).toBe("Found it: a race in the session cookie");
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

  it("briefs the chats a card starts, and keeps the brief out of their titles", () => {
    const reported = applyOp(board, { type: "report", id: "aaaaaa", text: "Narrowed it to auth.ts", column: "in_progress" }, 9);
    const target = reported.cards.find((c) => c.id === "aaaaaa")!;
    const investigate = investigatePrompt(target);
    expect(investigate).toContain("Card aaaaaa: Fix the flaky login test");
    expect(investigate).toContain("Fails on CI\nabout 1 in 5 runs");
    expect(investigate).toContain("- [moved to In progress] Narrowed it to auth.ts");
    expect(investigate).toContain("Do not change any files");
    expect(resolvePrompt(target)).toContain("move it to in_review");
    expect(resolvePrompt(target)).not.toContain("worktree");
    const worktree = { cwd: "/home/.pi-gna/worktrees/aaaaaa/repo", branch: "pigna/aaaaaa-fix-the-flaky-login-test", created: true, dirty: false };
    const resolve = resolvePrompt(target, worktree);
    expect(resolve).toContain("on branch pigna/aaaaaa-fix-the-flaky-login-test: your working directory, /home/.pi-gna/worktrees/aaaaaa/repo,");
    expect(resolve).toContain("leave the checkout at /repo as it is");
    expect(resolve).not.toMatch(/uncommitted|earlier chat/);
    expect(resolvePrompt(target, { ...worktree, created: false, dirty: true })).toMatch(/earlier chat on this card.*uncommitted changes/s);
    // "Chat about it" sends the card's details before your message; titles leave them out, the transcript shows a chip.
    const asked = `${cardBlock(target)}\n\nWhy does it only fail on CI?`;
    expect(stripStudioBlocks(asked)).toBe("Why does it only fail on CI?");
    expect(splitCardBlock(asked)).toEqual(["Why does it only fail on CI?", { id: "aaaaaa", title: "Fix the flaky login test" }]);
    expect(splitCardBlock(investigate)[0]).toMatch(/^Investigate this card[^<]*\n\nThis chat is attached to the card\./);
    expect(splitCardBlock("Why?")).toEqual(["Why?", undefined]);
    const long = applyOp(reported, { type: "report", id: "aaaaaa", text: "x".repeat(2000) }, 10).cards.find((c) => c.id === "aaaaaa")!;
    expect(cardBlock(long)).toContain(`${"x".repeat(600)}… (the rest: kanban_list with card aaaaaa)`);
    expect(cardBlock(long).length).toBeLessThan(1200);
  });

  it("has QA check the change where Resolve left it, without fixing it", () => {
    const reviewed = applyOp(board, { type: "report", id: "bbbbbb", text: "Added the toggle", column: "in_review" }, 9);
    const target = reviewed.cards.find((c) => c.id === "bbbbbb")!;
    expect(hasWorktree(target)).toBe(false);
    const here = qaPrompt(target);
    expect(here).toContain("Card bbbbbb: Ship dark mode\nColumn: In review");
    expect(here).toContain("- [moved to In review] Added the toggle");
    expect(here).toContain("The change was made in the project folder");
    expect(here).toContain("Do not fix what you find");
    expect(here).toContain("leave the card in in_review if it passes, or move it to in_progress");
    expect(here).not.toContain("worktree");

    const cwd = "/home/.pi-gna/worktrees/bbbbbb/repo";
    const resolved = applyOp(reviewed, { type: "attach", id: "bbbbbb", chat: { path: "/s/b3.jsonl", cwd } }, 10).cards.find((c) => c.id === "bbbbbb")!;
    expect(hasWorktree(resolved)).toBe(true);
    const there = qaPrompt(resolved, { cwd, branch: "pigna/bbbbbb-ship-dark-mode", created: false, dirty: true });
    expect(there).toContain(`The change is on branch pigna/bbbbbb-ship-dark-mode, in a git worktree of the project: your working directory, ${cwd},`);
    expect(there).toContain("Do not commit, push or merge, and leave the checkout at /repo as it is.");
    expect(there).not.toMatch(/project folder|uncommitted changes, which/);
  });
});

describe("adding a card from a description", () => {
  it("titles it with the description's start, cut at a word", () => {
    expect(draftTitle("  Fix the\nlogin  ")).toBe("Fix the login");
    const long = "When I drag a card into the done column while a chat on it is still running the board flickers and the card jumps back";
    const title = draftTitle(long);
    expect(title).toBe("When I drag a card into the done column while a chat on it is still running…");
    expect(title.length).toBeLessThanOrEqual(80);
    expect(draftTitle("x".repeat(200))).toBe(`${"x".repeat(79)}…`);
    // The card shows its description under the title only when the title does not already say it all.
    const short = applyOp(emptyBoard(), { type: "add", id: "eeeeee", title: draftTitle("Fix the login"), notes: "Fix the login", cwd: "/repo" }, 1).cards[0]!;
    expect(cardSnippet(short)).toBe("");
  });

  it("reuses the project's tags, most used first", () => {
    const tagged = [
      { type: "edit", id: "aaaaaa", tags: ["ci", "auth"] },
      { type: "edit", id: "bbbbbb", tags: ["ui", "auth"] },
      { type: "edit", id: "cccccc", tags: ["elsewhere"] },
    ] satisfies BoardOp[];
    const next = tagged.reduce((current, op) => applyOp(current, op, 20), board);
    expect(boardTags(next, "/repo")).toEqual(["auth", "ci", "ui"]);
    const prompt = triagePrompt(next.cards.find((c) => c.id === "aaaaaa")!, boardTags(next, "/repo"));
    expect(prompt).toContain("Tags: ci, auth\n");
    expect(prompt).toContain("reusing the board's where they fit: auth, ci, ui");
    expect(prompt).toContain("call kanban_update once, without a column");
    expect(triagePrompt(card("aaaaaa"), [])).not.toContain("reusing");
  });

  it("runs a task on its own provider, else the chat's when it has the model, else any", () => {
    const model = (provider: string, id: string) => ({ provider, id }) as Model;
    const models = [model("anthropic", "claude-opus-5-5"), model("anthropic", "claude-sonnet-5-5"), model("claude-bridge", "claude-sonnet-5-5")];
    const sonnet = { id: "claude-sonnet-5-5" };
    expect(pickModel(models, sonnet, "claude-bridge")).toBe(models[2]);
    expect(pickModel(models, sonnet, "openai")).toBe(models[1]);
    expect(pickModel(models, sonnet, undefined)).toBe(models[1]);
    expect(pickModel(models, { ...sonnet, provider: "anthropic" }, "claude-bridge")).toBe(models[1]);
    expect(pickModel(models, { ...sonnet, provider: "openai" }, "claude-bridge")).toBe(models[2]);
    expect(pickModel(models, { id: "claude-sonnet-9" }, "anthropic")).toBeUndefined();
  });
});

describe("a new card's attachments", () => {
  const paths = ["/data/card-images/eeeeee/image-1.png", "/Users/me/Library/Application Support/spec.pdf"];

  it("are listed in the notes after the description, one path per line, and read back", () => {
    const notes = cardNotes("  The button is cut off  ", paths);
    expect(notes).toBe(`The button is cut off\n\nAttachments:\n- ${paths[0]}\n- ${paths[1]}`);
    expect(splitAttachments(notes)).toEqual({ text: "The button is cut off", paths });
    expect(cardNotes("", paths.slice(0, 1))).toBe(`Attachments:\n- ${paths[0]}`);
    expect(cardNotes("Just text", [])).toBe("Just text");
    // What you write after the list stays in the text; a list of something else is left alone.
    expect(splitAttachments(`${notes}\n\nAlso on Safari`)).toEqual({ text: "The button is cut off\n\nAlso on Safari", paths });
    expect(splitAttachments("Attachments:\n- see the PR")).toEqual({ text: "Attachments:\n- see the PR", paths: [] });
  });

  it("stay off the board's snippet, and the triage looks at them first", () => {
    const added = applyOp(emptyBoard(), { type: "add", id: "eeeeee", title: draftTitle("Fix the login"), notes: cardNotes("Fix the login", paths), cwd: "/repo" }, 1).cards[0]!;
    expect(cardSnippet(added)).toBe("");
    const prompt = triagePrompt(added, []);
    expect(prompt).toContain(`Attachments:\n- ${paths[0]}\n`);
    expect(prompt).toContain("Read the files under Attachments in the notes first: screenshots show as images.");
    expect(triagePrompt(card("aaaaaa"), [])).not.toContain("under Attachments");
  });
});
