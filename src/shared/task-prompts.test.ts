import { describe, expect, it } from "vitest";
import { applyOp, type Board, type BoardOp, emptyBoard } from "./board";
import type { GithubItem } from "./github";
import type { Model } from "./protocol";
import { applyLamentOp, emptyLaments, type LamentOp } from "./laments";
import {
  boardTags,
  cardBlock,
  cardNotes,
  draftTitle,
  fixPrompt,
  hasWorktree,
  inChatPrompt,
  investigatePrompt,
  lamentBlock,
  pickModel,
  qaPrompt,
  resolvePrompt,
  reviewName,
  reviewPrompt,
  splitAttachments,
  triagePrompt,
} from "./task-prompts";

const ops: BoardOp[] = [
  { type: "add", id: "aaaaaa", title: "Fix the flaky login test", notes: "Fails on CI\nabout 1 in 5 runs", cwd: "/repo", before: null },
  { type: "add", id: "bbbbbb", title: "Ship dark mode", cwd: "/repo", column: "in_progress", before: null },
  { type: "add", id: "cccccc", title: "Other project", cwd: "/other", before: null },
  { type: "attach", id: "bbbbbb", chat: { path: "/s/b1.jsonl", cwd: "/repo" } },
];
const board: Board = ops.reduce((current, op, index) => applyOp(current, op, index), emptyBoard());
const card = (id: string) => board.cards.find((other) => other.id === id) ?? board.cards[0]!;
const repo = { host: "github.com", repo: "acme/app" };
const item: GithubItem = {
  kind: "pr",
  number: 7,
  title: "  Fix the login  ",
  state: "open",
  author: "octocat",
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  url: "https://github.com/acme/app/pull/7",
  body: "\nSteps to reproduce\n",
  draft: true,
};
const lamentOps: LamentOp[] = [{ type: "file", id: "aaaaaa", title: "No tab recorder", text: "Recorded\n the screen", severity: "annoying", cwd: "/repo", chat: { path: "/s/a.jsonl", cwd: "/repo" } }];
const laments = lamentOps.reduce((current, op, index) => applyLamentOp(current, op, 1000 + index), emptyLaments());

describe("the chats a card starts", () => {
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

describe("a card task in the chat you are in", () => {
  it("is the new chat's prompt, told to work in this chat's folder", () => {
    expect(inChatPrompt(card("aaaaaa"), "investigate")).toBe(investigatePrompt(card("aaaaaa")));
    const resolve = inChatPrompt(card("aaaaaa"), "resolve");
    expect(resolve).toContain("Card aaaaaa");
    expect(resolve).toContain("You work here, in this chat's folder");
    expect(resolve).not.toContain("git worktree of the project, on branch");
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

  it("honors an explicit provider; id-only selections prefer the chat provider then any", () => {
    const model = (provider: string, id: string) => ({ provider, id }) as Model;
    const models = [model("anthropic", "claude-opus-5-5"), model("anthropic", "claude-sonnet-5-5"), model("claude-bridge", "claude-sonnet-5-5")];
    const sonnet = { id: "claude-sonnet-5-5" };
    expect(pickModel(models, sonnet, "claude-bridge")).toBe(models[2]);
    expect(pickModel(models, sonnet, "openai")).toBe(models[1]);
    expect(pickModel(models, sonnet, undefined)).toBe(models[1]);
    expect(pickModel(models, { ...sonnet, provider: "anthropic" }, "claude-bridge")).toBe(models[1]);
    expect(pickModel(models, { ...sonnet, provider: "openai" }, "claude-bridge")).toBeUndefined();
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
    const prompt = triagePrompt(added, []);
    expect(prompt).toContain(`Attachments:\n- ${paths[0]}\n`);
    expect(prompt).toContain("Read the files under Attachments in the notes first: screenshots show as images.");
    expect(triagePrompt(card("aaaaaa"), [])).not.toContain("under Attachments");
  });
});

describe("fixing a lament", () => {
  const repeats: LamentOp[] = ["second", "third", "fourth", "fifth"].map((text) => ({ type: "repeat", id: "aaaaaa", text: `${text} time`, severity: "costly" }));
  const lament = repeats.reduce((current, op, index) => applyLamentOp(current, op, 2000 + index), laments).laments.find((other) => other.id === "aaaaaa");
  if (!lament) throw new Error("no lament");

  it("briefs the chat with how the lament was filed and its latest evidence, whole", () => {
    const block = lamentBlock(lament);
    expect(block).toMatch(/^<lament>\nLament aaaaaa: No tab recorder\nSeverity: 😠 Costly/);
    expect(block).toContain("Hit 5 times");
    expect(block).toContain("Recorded\n the screen");
    expect(block).toContain("(2 in between left out)");
    expect(block).not.toMatch(/second time|third time/);
    expect(block).toMatch(/fourth time[\s\S]*fifth time\n<\/lament>$/);
  });

  it("works in the lament's worktree, commits there and leaves resolving to you", () => {
    const worktree = { cwd: "/home/.pi-gna/worktrees/aaaaaa/repo", branch: "pigna/aaaaaa-fix-no-tab-recorder", created: true, dirty: false };
    const prompt = fixPrompt(lament, worktree);
    expect(prompt).toMatch(/^Fix the gap this lament/);
    expect(prompt).toContain("on branch pigna/aaaaaa-fix-no-tab-recorder: your working directory, /home/.pi-gna/worktrees/aaaaaa/repo,");
    expect(prompt).toContain("commit it on the branch");
    expect(prompt).toContain("leave the checkout at /repo as it is");
    expect(prompt).toContain("I mark the lament resolved");
    expect(fixPrompt(lament, { ...worktree, created: false })).toContain("earlier chat on this lament");
    expect(fixPrompt(lament)).not.toContain("worktree");
  });
});

describe("reviewing a pull request", () => {
  it("asks a review chat to review the pull request with pr-review, as the page's account", () => {
    const pr = { ...item, head: "fix-login", base: "main" };
    expect(reviewName(pr)).toBe("Review PR #7: Fix the login");
    const prompt = reviewPrompt(repo, pr, "work-me");
    expect(prompt).toContain("with the pr-review skill");
    expect(prompt).toContain("PR #7 of acme/app: Fix the login (https://github.com/acme/app/pull/7)\nBranch fix-login into main, by octocat, a draft.");
    expect(prompt).toContain('GH_TOKEN="$(gh auth token --hostname github.com --user work-me)" gh');
    expect(prompt).toContain("do not comment, approve or request changes on GitHub unless I ask");
    // A merged one says so; Enterprise Server takes its own variable; no account, no hint.
    expect(reviewPrompt(repo, { ...pr, state: "merged" }, "me")).toContain("by octocat, merged.");
    expect(reviewPrompt({ host: "git.acme.dev", repo: "acme/app" }, pr, "me")).toContain('GH_ENTERPRISE_TOKEN="$(gh auth token --hostname git.acme.dev --user me)"');
    expect(reviewPrompt(repo, pr)).not.toContain("gh auth token");
  });
});
