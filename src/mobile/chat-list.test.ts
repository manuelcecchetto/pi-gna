import { describe, expect, it } from "vitest";
import type { AttentionSummary } from "../shared/host-api";
import type { ProjectGroup } from "../shared/ipc";
import { chatItems, projectItems } from "./chat-list";
import { draftKey, loadDraft, saveDraft, withRestored } from "./drafts";

const session = (path: string, modifiedAt: number, title = path) => ({ path, id: path, cwd: "/a", title, named: false, createdAt: 1, modifiedAt });
const projects: ProjectGroup[] = [
  { cwd: "/a", modifiedAt: 50, sessions: [session("/a/1.jsonl", 10), session("/a/2.jsonl", 50)] },
  { cwd: "/b", modifiedAt: 80, sessions: [session("/b/1.jsonl", 80)] },
  { cwd: "/c", modifiedAt: 5, sessions: [session("/c/1.jsonl", 5)] },
];
const live = (handle: string, sessionPath: string, level: AttentionSummary["attention"]): AttentionSummary => ({ handle, cwd: "/a", sessionPath, title: handle, attention: level, running: level === "running", dialogs: 0 });

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
