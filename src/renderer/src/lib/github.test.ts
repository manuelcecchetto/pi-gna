import { describe, expect, it } from "vitest";
import { applyOp, type BoardOp, emptyBoard, type GithubRef, LIMITS } from "../../../shared/board";
import type { GithubItem } from "../../../shared/github";
import type { ProjectGroup } from "../../../shared/ipc";
import { cardFromItem, githubProjects, imagesAsLinks, itemLook, labelColor, LINKABLE, linkableCards, linkedCards } from "./github";

const repo = { host: "github.com", repo: "acme/app" };
const ref = (number: number, kind: GithubRef["kind"] = "issue"): GithubRef => ({
  kind,
  host: "github.com",
  repo: "acme/app",
  number,
  url: `https://github.com/acme/app/${kind === "pr" ? "pull" : "issues"}/${number}`,
  title: `Item ${number}`,
});
const ops: BoardOp[] = [
  { type: "add", id: "aaaaaa", title: "Linked", cwd: "/repo", github: [ref(12)] },
  { type: "add", id: "bbbbbb", title: "Free", cwd: "/repo" },
  { type: "add", id: "cccccc", title: "Done", cwd: "/repo", column: "done" },
  { type: "add", id: "dddddd", title: "Worktree twin", cwd: "/other", github: [{ ...ref(12), repo: "ACME/app" }] },
];
const board = ops.reduce((current, op, index) => applyOp(current, op, 1000 + index), emptyBoard());
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

describe("GitHub view", () => {
  it("offers the current project, then the sidebar's", () => {
    const projects = [{ cwd: "/repo", modifiedAt: 1, sessions: [] }, { cwd: "/new", modifiedAt: 1, sessions: [] }] as ProjectGroup[];
    expect(githubProjects(projects, "/new")).toEqual([
      { cwd: "/new", open: 0 },
      { cwd: "/repo", open: 0 },
    ]);
  });

  it("finds the cards that link an item in any project, whatever the case of its repository", () => {
    const linked = linkedCards(board);
    expect(linked.get("github.com/acme/app#12")?.map((card) => card.id).sort()).toEqual(["aaaaaa", "dddddd"]);
    expect(linked.get("github.com/acme/app#13")).toBeUndefined();
  });

  it("links to the project's cards that are not done and not linked yet, latest change first", () => {
    expect(linkableCards(board, "/repo", ref(12)).map((card) => card.id)).toEqual(["bbbbbb"]);
    expect(linkableCards(board, "/repo", ref(13)).map((card) => card.id)).toEqual(["bbbbbb", "aaaaaa"]);
    const many = Array.from({ length: LINKABLE + 3 }, (_, index): BoardOp => ({ type: "add", title: `Card ${index}`, cwd: "/many", id: `m${String(index).padStart(5, "0")}` }));
    const crowded = many.reduce((current, op, index) => applyOp(current, op, index), emptyBoard());
    const shown = linkableCards(crowded, "/many", ref(1));
    expect(shown).toHaveLength(LINKABLE);
    expect(shown[0]?.title).toBe(`Card ${LINKABLE + 2}`);
  });

  it("leaves out cards that cannot take another link", () => {
    const full = applyOp(emptyBoard(), { type: "add", id: "ffffff", title: "Full", cwd: "/repo", github: Array.from({ length: LIMITS.github }, (_, index) => ref(100 + index)) }, 1);
    expect(linkableCards(full, "/repo", ref(1))).toEqual([]);
  });

  it("makes a To do card of an item that the board accepts", () => {
    const op = cardFromItem("/repo", repo, item);
    expect(op).toEqual({
      type: "add",
      title: "Fix the login",
      notes: "Steps to reproduce",
      cwd: "/repo",
      column: "todo",
      github: [{ kind: "pr", host: "github.com", repo: "acme/app", number: 7, url: item.url, title: "  Fix the login  " }],
    });
    const added = applyOp(emptyBoard(), { ...op, id: "eeeeee" }, 1).cards[0];
    expect(added?.github[0]?.title).toBe("Fix the login");
    const long = cardFromItem("/repo", repo, { ...item, title: " ", body: "x".repeat(LIMITS.notes + 5) });
    expect(long.title).toBe("PR #7");
    expect(long.notes).toHaveLength(LIMITS.notes);
  });

  it("turns images into links outside code, for the notes and the page (CSP blocks remote images)", () => {
    const body = [
      'Occurrence 1:\n<img width="383" alt="Image" src="https://github.com/user-attachments/assets/a1" />',
      '<p align="center"><img src=\'https://x.test/b.png\' alt="the [chat] box"></p>',
      "![screenshot](https://x.test/c.png) and ![](<https://x.test/d.png> \"title\")",
      "<img alt=nothing>",
      "```html\n<img src=\"keep.png\">\n![keep](keep.png)\n```",
      "Inline `<img src=\"keep.png\">` stays.",
    ].join("\n\n");
    expect(imagesAsLinks(body).split("\n\n")).toEqual([
      'Occurrence 1:\n<a href="https://github.com/user-attachments/assets/a1">Image</a>',
      '<p align="center"><a href="https://x.test/b.png">Image: the chat box</a></p>',
      "[Image: screenshot](https://x.test/c.png) and [Image](https://x.test/d.png)",
      "",
      "```html\n<img src=\"keep.png\">\n![keep](keep.png)\n```",
      "Inline `<img src=\"keep.png\">` stays.",
    ]);
    const card = cardFromItem("/repo", repo, { ...item, body: "![](https://x.test/e.png)" });
    expect(card.notes).toBe("[Image](https://x.test/e.png)");
  });

  it("draws an item's state as GitHub does", () => {
    expect(itemLook(item)).toBe("draft");
    expect(itemLook({ ...item, draft: false })).toBe("open");
    expect(itemLook({ ...item, state: "merged" })).toBe("merged");
    expect(itemLook({ ...item, state: "closed" })).toBe("closed");
    expect(itemLook({ kind: "issue", state: "open", draft: true })).toBe("open");
  });

  it("uses a label's color only when it is a hex color", () => {
    expect(labelColor("d73a4a")).toBe("#d73a4a");
    expect(labelColor("red;background:url(x)")).toBeUndefined();
  });
});
