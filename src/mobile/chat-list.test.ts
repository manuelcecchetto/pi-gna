import { describe, expect, it } from "vitest";
import type { AttentionSummary } from "../shared/host-api";
import type { ProjectGroup } from "../shared/ipc";
import { chatItems, projectItems, searchChats, searchProjects } from "./chat-list";
import { draftKey, loadDraft, saveDraft, withRestored } from "./drafts";

const session = (path: string, modifiedAt: number, title = path) => ({ path, id: path, cwd: "/a", title, named: false, createdAt: 1, modifiedAt });
const projects: ProjectGroup[] = [
  { cwd: "/a", modifiedAt: 50, sessions: [session("/a/1.jsonl", 10), session("/a/2.jsonl", 50)] },
  { cwd: "/b", modifiedAt: 80, sessions: [session("/b/1.jsonl", 80)] },
  { cwd: "/c", modifiedAt: 5, sessions: [session("/c/1.jsonl", 5)] },
];
const live = (handle: string, sessionPath: string, level: AttentionSummary["attention"]): AttentionSummary => ({ handle, cwd: "/a", sessionPath, title: handle, listed: true, attention: level, running: level === "running", dialogs: 0 });

describe("project and chat lists", () => {
  it("orders projects like the sidebar: pins first, then latest activity", () => {
    expect(projectItems(projects, [], {}).map((p) => p.cwd)).toEqual(["/b", "/a", "/c"]);
    expect(projectItems(projects, ["/c"], {}).map((p) => [p.cwd, p.pinned])).toEqual([["/c", true], ["/b", false], ["/a", false]]);
  });

  it("rolls the strongest live mark up to the project and marks the chat row", () => {
    const attention = { h1: live("h1", "/a/1.jsonl", "unread"), h2: live("h2", "/a/2.jsonl", "waiting"), h3: live("h3", "/b/1.jsonl", "idle") };
    const items = projectItems(projects, [], attention);
    expect(items.find((p) => p.cwd === "/a")).toMatchObject({ attention: "waiting", chats: 2, time: 50 });
    expect(items.find((p) => p.cwd === "/b")!.attention).toBeUndefined();
    expect(chatItems(projects, [], attention, "/a")).toMatchObject([
      { path: "/a/2.jsonl", handle: "h2", attention: "waiting" },
      { path: "/a/1.jsonl", handle: "h1", attention: "unread" },
    ]);
    expect(chatItems(projects, [], attention, "/b")[0]).toMatchObject({ handle: "h3", attention: undefined });
    expect(chatItems(projects, [], attention, "/missing")).toEqual([]);
  });

  it("shows unread per device: a chat this phone opened for that outcome is quiet until it settles again", () => {
    const settled = (at: number): AttentionSummary => ({ ...live("h1", "/a/1.jsonl", "unread"), settled: { outcome: "done", at } });
    expect(chatItems(projects, [], { h1: settled(100) }, "/a", { h1: 100 }).find((c) => c.handle === "h1")).toMatchObject({ attention: undefined, settledAt: 100 });
    expect(chatItems(projects, [], { h1: settled(200) }, "/a", { h1: 100 }).find((c) => c.handle === "h1")!.attention).toBe("unread");
    expect(projectItems(projects, [], { h1: settled(100) }, { h1: 100 }).find((p) => p.cwd === "/a")!.attention).toBeUndefined();
  });

  it("searches projects by folder or chat title, and chats by title", () => {
    const named: ProjectGroup[] = [{ cwd: "/a/alpha", modifiedAt: 2, sessions: [session("/a/1.jsonl", 1, "Fix login bug")] }, { cwd: "/a/beta", modifiedAt: 1, sessions: [session("/b/1.jsonl", 1, "Write docs")] }];
    const items = projectItems(named, [], {});
    expect(searchProjects(items, "beta").map((p) => p.cwd)).toEqual(["/a/beta"]);
    expect(searchProjects(items, "login").map((p) => p.cwd)).toEqual(["/a/alpha"]);
    expect(searchProjects(items, " ")).toHaveLength(2);
    expect(searchChats(chatItems(named, [], {}, "/a/alpha"), "docs")).toEqual([]);
  });

  it("shows a started chat before the index has its file, like the desktop sidebar", () => {
    const started = { ...live("h9", "/a/9.jsonl", "running"), title: "New idea" };
    const fresh = { ...live("h8", "/d/8.jsonl", "unread"), cwd: "/d" };
    const attention = { h9: started, h8: fresh };
    expect(chatItems(projects, [], attention, "/a")).toMatchObject([
      { path: "/a/9.jsonl", handle: "h9", title: "New idea", attention: "running" },
      { path: "/a/2.jsonl" },
      { path: "/a/1.jsonl" },
    ]);
    expect(chatItems(projects, [], attention, "/d")).toMatchObject([{ path: "/d/8.jsonl", handle: "h8", attention: "unread" }]);
    // Projects with a just-started chat lead the unpinned ones; pins stay first.
    const items = projectItems(projects, ["/c"], attention);
    expect(items.map((p) => p.cwd)).toEqual(["/c", "/a", "/d", "/b"]);
    expect(items.find((p) => p.cwd === "/a")).toMatchObject({ chats: 3, attention: "running" });
    expect(items.find((p) => p.cwd === "/d")).toMatchObject({ chats: 1, attention: "unread", time: undefined, titles: ["h8"] });
    expect(searchProjects(items, "New idea").map((p) => p.cwd)).toEqual(["/a"]);
  });

  it("leaves out drafts, triage and ATP chats, and chats without a session file yet", () => {
    const attention = { h9: { ...live("h9", "/a/9.jsonl", "idle"), listed: false }, h7: { ...live("h7", "", "running"), sessionPath: undefined } };
    expect(chatItems(projects, [], attention, "/a").map((c) => c.path)).toEqual(["/a/2.jsonl", "/a/1.jsonl"]);
    expect(projectItems(projects, [], attention).find((p) => p.cwd === "/a")!.chats).toBe(2);
  });

  it("drops a live chat's extra row once the index has its file", () => {
    const attention = { h1: live("h1", "/a/1.jsonl", "running") };
    expect(chatItems(projects, [], attention, "/a").map((c) => c.path)).toEqual(["/a/2.jsonl", "/a/1.jsonl"]);
  });
});

describe("drafts", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
  };

  it("keeps a draft per chat and drops it when emptied", () => {
    const store = memory();
    const key = draftKey({ sessionPath: "/a/1.jsonl", handle: "h1" });
    expect(draftKey({ handle: "h1" })).not.toBe(key);
    saveDraft(key, "half a thought", store);
    expect(loadDraft(key, store)).toBe("half a thought");
    expect(loadDraft(draftKey({ sessionPath: "/a/2.jsonl", handle: "h2" }), store)).toBe("");
    saveDraft(key, "", store);
    expect(store.data.size).toBe(0);
  });

  it("puts restored queue texts in front of the draft", () => {
    expect(withRestored("typed", ["one", " two "])).toBe("one\n\ntwo\n\ntyped");
    expect(withRestored("", ["one"])).toBe("one");
    expect(withRestored("typed", [])).toBe("typed");
  });
});
