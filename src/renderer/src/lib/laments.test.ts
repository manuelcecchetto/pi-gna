import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "../../../shared/ipc";
import { applyLamentOp, emptyLaments, type LamentOp } from "../../../shared/laments";
import { lamentProjects, lamentSnippet, reportChat, worstSeverity } from "./laments";

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
});
