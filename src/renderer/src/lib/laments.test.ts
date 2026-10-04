import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "../../../shared/ipc";
import { applyLamentOp, emptyLaments, type LamentOp } from "../../../shared/laments";
import { fixChat, fixPrompt, lamentBlock, lamentProjects, lamentSnippet, reportChat, worstSeverity } from "./laments";

const ops: LamentOp[] = [
  { type: "file", id: "aaaaaa", title: "No tab recorder", text: "Recorded\n the screen", severity: "annoying", cwd: "/repo", chat: { path: "/s/a.jsonl", cwd: "/repo" } },
  { type: "file", id: "bbbbbb", title: "Logs truncated", text: "x", severity: "costly", cwd: "/repo" },
  { type: "file", id: "cccccc", title: "Elsewhere", text: "x", severity: "blocking", cwd: "/other" },
  { type: "resolve", id: "cccccc", resolved: true },
];
const laments = ops.reduce((current, op, index) => applyLamentOp(current, op, 1000 + index), emptyLaments());
const projects: ProjectGroup[] = [
  { cwd: "/sidebar", modifiedAt: 1, sessions: [{ path: "/s/a.jsonl", id: "a", cwd: "/repo", title: "Record a demo", named: true, createdAt: 1, modifiedAt: 1 }] },
];

describe("laments view", () => {
  it("offers the current project, the sidebar's and those with laments, counting open ones", () => {
    expect(lamentProjects(laments, projects, "/new")).toEqual([
      { cwd: "/new", open: 0 },
      { cwd: "/sidebar", open: 0 },
      { cwd: "/repo", open: 2 },
      { cwd: "/other", open: 0 },
    ]);
  });

  it("sums laments up by the worst of them", () => {
    expect(worstSeverity(laments.laments.filter((lament) => lament.cwd === "/repo"))).toBe("costly");
    expect(worstSeverity(laments.laments)).toBe("blocking");
    expect(worstSeverity([])).toBeUndefined();
  });

  it("shows the latest report and opens the chat that filed it", () => {
    const lament = laments.laments[0];
    const report = lament?.reports[0];
    if (!lament || !report) throw new Error("no lament");
    expect(lamentSnippet(lament)).toBe("Recorded the screen");
    expect(reportChat(projects, report)?.title).toBe("Record a demo");
    expect(reportChat(projects, { at: 1, text: "x", severity: "annoying" })).toBeUndefined();
  });

  it("opens a Fix chat, by its title when the sidebar knows it", () => {
    expect(fixChat(projects, { at: 1, chat: { path: "/s/a.jsonl", cwd: "/repo" } }).title).toBe("Record a demo");
    expect(fixChat(projects, { at: 1, chat: { path: "/s/gone.jsonl", cwd: "/repo" } })).toMatchObject({ path: "/s/gone.jsonl", cwd: "/repo" });
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
