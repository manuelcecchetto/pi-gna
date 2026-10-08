import { describe, expect, it } from "vitest";
import { worktreeCwd } from "../../../shared/board";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { chatGlance, projectViews as viewsOfChats } from "./projects";
import { shallow } from "./store";
import { createSession, type SessionState } from "../../../shared/session-state";
import { openChat } from "../state/app";

const projectViews = (projects: ProjectGroup[], open: SessionState[], pinned: string[], hidden?: string[]) => viewsOfChats(projects, open.map(openChat), pinned, hidden);

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

/** A chat opened from the sidebar: live, hydrated from its file, nothing sent from pi-gna. */
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

  it("lists a chat in a card's worktree under its project", () => {
    const resolving: SessionState = { ...createSession("h1", worktreeCwd("/home", "abc123", "/b")), prompted: true, items: [user("fix it", 500)] };
    const views = projectViews(projects, [resolving], []);
    expect(order(views)).toEqual(["/b", "/a", "/c"]);
    expect(views[0]?.rows.map((r) => r.live?.handle ?? r.summary?.id)).toEqual(["h1", "b1"]);
  });

  it("puts pinned projects first, in the order they were pinned", () => {
    expect(order(projectViews(projects, [], ["/c", "/b"]))).toEqual(["/c", "/b", "/a"]);
    expect(projectViews(projects, [], ["/c"]).map((v) => v.pinned)).toEqual([true, false, false]);
  });

  it("puts hidden projects last, flagged, even when pinned", () => {
    const views = projectViews(projects, [], ["/a"], ["/a", "/b"]);
    expect(order(views)).toEqual(["/c", "/a", "/b"]);
    expect(views.map((v) => v.hidden)).toEqual([false, true, true]);
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

  it("leaves out card triage chats, and projects that only have those", () => {
    const triage = { ...summary("/c", "t", 900), named: true, title: "Triage: fix the flash" };
    const onlyTriage = { ...summary("/t", "t", 950), named: true, title: "Triage: other" };
    const running: SessionState = { ...createSession("t1", "/b"), prompted: true, name: "Triage: new card" };
    const withTriage = [project("/t", onlyTriage), ...projects.slice(0, 2), project("/c", triage, ...(projects[2]?.sessions ?? []))];
    const views = projectViews(withTriage, [running], []);
    expect(order(views)).toEqual(["/a", "/b", "/c"]); // a triage does not move its project up either
    expect(views[1]?.rows.map((r) => r.key)).toEqual(["/b/b1.jsonl"]);
    expect(views[2]?.rows.map((r) => r.key)).toEqual(["/c/c1.jsonl", "/c/c2.jsonl"]);
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

describe("openChat", () => {
  const running: SessionState = { ...createSession("oc1", "/a"), prompted: true, running: true, items: [user("fix the flash", 500)] };

  it("is the same object while a chat streams, so the sidebar rows do not render", () => {
    const chat = openChat(running);
    const streamed: SessionState = { ...running, items: [...running.items] };
    expect(openChat(streamed)).toBe(chat);
    expect(chat).toMatchObject({ handle: "oc1", title: "fix the flash", attention: "running", sentAt: 500, listed: true, draft: false, exited: false });
  });

  it("is a new object once what the row shows changes", () => {
    const chat = openChat(running);
    const settled = openChat({ ...running, running: false, unread: "done" });
    expect(settled).not.toBe(chat);
    expect(settled.attention).toBe("unread");
    expect(openChat({ ...running, running: false, unread: "done", name: "Flash fix" }).title).toBe("Flash fix");
  });
});

describe("chatGlance", () => {
  const running: SessionState = { ...createSession("cg1", "/a"), prompted: true, running: true, items: [user("plan it", 500)] };
  const answer = (text: string) => ({ kind: "assistant" as const, key: "a1", message: { role: "assistant" as const, content: [{ type: "text" as const, text }] } }) as unknown as SessionState["items"][number];

  it("stays shallow-equal while an answer streams into its item, so the ATP page does not render", () => {
    const first = { ...running, items: [...running.items, answer("one")] };
    const later = { ...first, items: [...running.items, answer("one two three")] };
    expect(shallow(chatGlance(first), chatGlance(later))).toBe(true);
    expect(chatGlance(later)).toEqual({ talked: true, running: true, mark: "2:true" });
  });

  it("changes when an item is added or the run ends", () => {
    expect(shallow(chatGlance(running), chatGlance({ ...running, items: [...running.items, answer("one")] }))).toBe(false);
    expect(chatGlance({ ...running, running: false })).toEqual({ talked: true, running: false, mark: "1:false" });
  });

  it("is not talked to before anything was sent, and undefined without a chat", () => {
    expect(chatGlance(createSession("cg2", "/a"))).toEqual({ talked: false, running: false, mark: "0:false" });
    expect(chatGlance({ ...createSession("cg3", "/a"), running: true })?.talked).toBe(true);
    expect(chatGlance(undefined)).toBeUndefined();
  });
});
