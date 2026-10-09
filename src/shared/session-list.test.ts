import { describe, expect, it } from "vitest";
import type { SessionSummary } from "./ipc";
import { groupSessions, patchProjects } from "./session-list";

const chat = (path: string, cwd: string, modifiedAt: number, title = path): SessionSummary => ({
  path,
  id: path,
  cwd,
  title,
  named: false,
  createdAt: 0,
  modifiedAt,
});

describe("session list", () => {
  const list = groupSessions([chat("a1", "/a", 30), chat("b1", "/b", 20), chat("a2", "/a", 10), undefined]);

  it("groups by project, newest first", () => {
    expect(list.map((g) => [g.cwd, g.modifiedAt, g.sessions.map((s) => s.path)])).toEqual([
      ["/a", 30, ["a1", "a2"]],
      ["/b", 20, ["b1"]],
    ]);
  });

  it("counts a card's worktree as its project", () => {
    const [group] = groupSessions([chat("w", "/Users/me/.pi-gna/worktrees/abc123/Users/me/code/app", 1)]);
    expect(group?.cwd).toBe("/Users/me/code/app");
  });

  it("moves a settled chat and its project to the top, with its new title", () => {
    const next = patchProjects(list, "b1", chat("b1", "/b", 40, "Renamed"));
    expect(next.map((g) => [g.cwd, g.modifiedAt, g.sessions.map((s) => s.title)])).toEqual([
      ["/b", 40, ["Renamed"]],
      ["/a", 30, ["a1", "a2"]],
    ]);
  });

  it("adds a new chat, in a new project too", () => {
    expect(patchProjects(list, "a3", chat("a3", "/a", 50))[0]?.sessions.map((s) => s.path)).toEqual(["a3", "a1", "a2"]);
    expect(patchProjects(list, "c1", chat("c1", "/c", 5)).map((g) => g.cwd)).toEqual(["/a", "/b", "/c"]);
  });

  it("drops a chat that lists nothing, and its project once empty", () => {
    expect(patchProjects(list, "b1", null).map((g) => g.cwd)).toEqual(["/a"]);
    expect(patchProjects(list, "a2", null).map((g) => [g.cwd, g.sessions.map((s) => s.path)])).toEqual([
      ["/a", ["a1"]],
      ["/b", ["b1"]],
    ]);
  });

  it("keeps the same list when nothing changed, so nothing renders again", () => {
    expect(patchProjects(list, "zz", null)).toBe(list);
    expect(patchProjects(list, "a2", chat("a2", "/a", 10))).toBe(list);
    for (const change of [{ title: "x" }, { named: true }, { createdAt: 1 }, { modifiedAt: 11 }, { id: "other" }, { cwd: "/c" }]) {
      expect(patchProjects(list, "a2", { ...chat("a2", "/a", 10), ...change })).not.toBe(list);
    }
  });

  it("moves a chat whose project changed", () => {
    expect(patchProjects(list, "a1", chat("a1", "/b", 30)).map((g) => [g.cwd, g.sessions.map((s) => s.path)])).toEqual([
      ["/b", ["a1", "b1"]],
      ["/a", ["a2"]],
    ]);
  });

  it("matches a full regroup of the same files", () => {
    const updated = chat("a2", "/a", 60, "Later");
    expect(patchProjects(list, "a2", updated)).toEqual(groupSessions([chat("a1", "/a", 30), chat("b1", "/b", 20), updated]));
  });
});
