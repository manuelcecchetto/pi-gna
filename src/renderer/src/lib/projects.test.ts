import { describe, expect, it } from "vitest";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { projectViews } from "./projects";
import { createSession, type SessionState } from "./session";

const summary = (cwd: string, name: string, modifiedAt: number): SessionSummary => ({
  path: `${cwd}/${name}.jsonl`,
  id: name,
  cwd,
  title: name,
  named: false,
  createdAt: modifiedAt,
  modifiedAt,
});
const project = (cwd: string, ...sessions: SessionSummary[]): ProjectGroup => ({
  cwd,
  modifiedAt: Math.max(...sessions.map((s) => s.modifiedAt)),
  sessions: [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt),
});
const user = (text: string, timestamp: number) => ({ kind: "user" as const, key: text, message: { role: "user" as const, content: text, timestamp } });

/** A chat opened from the sidebar: live, hydrated from its file, nothing sent from studio. */
const opened = (handle: string, s: SessionSummary): SessionState => ({
  ...createSession(handle, s.cwd, s.path),
  items: [user("old", s.modifiedAt - 10)],
});

const projects = [
  project("/a", summary("/a", "a1", 300), summary("/a", "a2", 250)),
  project("/b", summary("/b", "b1", 200)),
  project("/c", summary("/c", "c1", 100), summary("/c", "c2", 90)),
];
const order = (views: { cwd: string }[]) => views.map((v) => v.cwd);

describe("projectViews", () => {
  it("keeps the order when you open chats in other projects", () => {
    const c2 = projects[2]?.sessions[1] as SessionSummary;
    const views = projectViews(projects, [opened("h1", c2)], []);
    expect(order(views)).toEqual(["/a", "/b", "/c"]);
    expect(views[2]?.rows.map((r) => r.summary?.id)).toEqual(["c1", "c2"]);
    expect(views[2]?.rows[1]?.live?.handle).toBe("h1");
  });

  it("puts pinned projects first, in the order they were pinned", () => {
    expect(order(projectViews(projects, [], ["/c", "/b"]))).toEqual(["/c", "/b", "/a"]);
    expect(projectViews(projects, [], ["/c"]).map((v) => v.pinned)).toEqual([true, false, false]);
  });

  it("ignores pins of folders that have no chats", () => {
    expect(order(projectViews(projects, [], ["/gone", "/b"]))).toEqual(["/b", "/a", "/c"]);
  });

  it("moves a project and its chat up when you send a message", () => {
    const c2 = projects[2]?.sessions[1] as SessionSummary;
    const sent: SessionState = { ...opened("h1", c2), prompted: true, items: [user("old", 80), user("new", 400)] };
    const views = projectViews(projects, [sent], []);
    expect(order(views)).toEqual(["/c", "/a", "/b"]);
    expect(views[0]?.rows.map((r) => [r.summary?.id, r.time])).toEqual([["c2", 400], ["c1", 100]]);
  });

  it("keeps pinned projects in place even when another project has newer activity", () => {
    const c2 = projects[2]?.sessions[1] as SessionSummary;
    const sent: SessionState = { ...opened("h1", c2), prompted: true, items: [user("new", 400)] };
    expect(order(projectViews(projects, [sent], ["/b"]))).toEqual(["/b", "/c", "/a"]);
  });

  it("shows a new chat on top of its project, and a new project, but never a draft", () => {
    const fresh: SessionState = { ...createSession("n1", "/a"), prompted: true, items: [user("hi", 500)] };
    const unsentYet: SessionState = { ...createSession("n2", "/b"), prompted: true };
    const draft = createSession("n3", "/d");
    const elsewhere: SessionState = { ...createSession("n4", "/e"), prompted: true, items: [user("hi", 150)] };
    const views = projectViews(projects, [fresh, unsentYet, draft, elsewhere], []);
    expect(order(views)).toEqual(["/a", "/b", "/e", "/c"]);
    expect(views[0]?.rows.map((r) => r.key)).toEqual(["n1", "/a/a1.jsonl", "/a/a2.jsonl"]);
    expect(views[1]?.rows.map((r) => r.key)).toEqual(["n2", "/b/b1.jsonl"]);
  });
});
