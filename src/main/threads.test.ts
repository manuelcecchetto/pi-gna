import { describe, expect, it } from "vitest";
import type { AttentionSummary } from "../shared/host-api";
import type { SessionSummary } from "../shared/ipc";
import type { SessionEntry } from "../shared/protocol";
import { threadsRoute } from "./threads";

const session = (id: string, cwd: string, title: string, modifiedAt: number): SessionSummary => ({ path: `/s/${id}.jsonl`, id, cwd, title, named: false, createdAt: 0, modifiedAt });
const SESSIONS = [
  session("0000-aaaa1111", "/repo", "Fix the login", 3_000),
  session("0000-bbbb1111", "/home/.pi-gna/worktrees/k1k1k1/repo", "Card k1 resolve", 2_000),
  session("0000-cccc3333", "/other", "Other project chat", 4_000),
  session("0000-aaaa9999", "/repo", "This chat", 1_000),
];

let at = 0;
const entry = (message: object): SessionEntry => ({ type: "message", id: String(++at), parentId: null, timestamp: "2026-10-10T12:00:00.000Z", message }) as SessionEntry;
const user = (text: string) => entry({ role: "user", content: text, timestamp: 0 });
const reply = (...content: object[]) => entry({ role: "assistant", content, stopReason: "stop", timestamp: 0 });

function route(entries: SessionEntry[] = [], live: Partial<AttentionSummary>[] = []) {
  return threadsRoute({
    identify: async () => ({ path: "/s/0000-aaaa9999.jsonl", cwd: "/repo" }),
    sessions: async () => [{ cwd: "/", modifiedAt: 0, sessions: SESSIONS }],
    live: () => live as AttentionSummary[],
    read: async () => entries,
  });
}

describe("threads_list", () => {
  it("lists the project's threads (worktrees included) newest first, with run state and this chat marked", async () => {
    const { text } = (await route([], [{ sessionPath: "/s/0000-bbbb1111.jsonl", running: true, attention: "running" }])("h", { action: "list" })) as { text: string };
    expect(text).toContain("Threads of /repo: 3");
    expect(text).not.toContain("Other project");
    expect(text.indexOf("aaaa1111")).toBeLessThan(text.indexOf("bbbb1111"));
    expect(text).toMatch(/bbbb1111 Card k1 resolve {2}\(open, running, updated .*\)\n {2}in \/home\/\.pi-gna\/worktrees/);
    expect(text).toMatch(/aaaa9999 This chat {2}\(this chat,/);
  });
  it("lists every project with all, and filters by title", async () => {
    const all = (await route()("h", { action: "list", all: true })) as { text: string };
    expect(all.text).toContain("Threads of every project: 4");
    const found = (await route()("h", { action: "list", all: true, query: "OTHER" })) as { text: string };
    expect(found.text).toContain(": 1,");
    expect(found.text).toContain("cccc3333 Other project chat");
  });
});

describe("thread_read", () => {
  const turns = [
    user("first question"),
    reply({ type: "text", text: "looking" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }),
    entry({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "SECRET OUTPUT" }], isError: true, timestamp: 0 }),
    reply({ type: "text", text: "first answer" }),
    user("second question"),
    reply({ type: "text", text: "second answer" }),
    user("third question"),
    reply({ type: "text", text: "third answer" }),
  ];

  it("shows the newest turns, tool calls as one line and no tool output, and how to page back", async () => {
    const { text } = (await route(turns)("h", { action: "read", thread: "3333", turns: 2 })) as { text: string };
    expect(text).toContain("Thread cccc3333: Other project chat");
    expect(text).toContain("Turns 2-3 of 3. Earlier: thread_read with before 2.");
    expect(text).not.toContain("first question");
    expect(text).toContain("User: third question\nAssistant: third answer");
  });
  it("pages back with before", async () => {
    const { text } = (await route(turns)("h", { action: "read", thread: "cccc3333", before: 2 })) as { text: string };
    expect(text).toContain("Turns 1-1 of 3.");
    expect(text).toContain('→ bash({"command":"ls"}) failed');
    expect(text).not.toContain("SECRET OUTPUT");
  });
  it("collapses a long run of tool calls to its ends", async () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({ type: "toolCall", id: `c${index}`, name: `tool${index}`, arguments: {} }));
    const { text } = (await route([user("go"), reply(...calls, { type: "text", text: "done" })])("h", { action: "read", thread: "3333" })) as { text: string };
    expect(text).toContain("→ tool2({})\n… 4 more tool calls\n→ tool7({})");
    expect(text).not.toContain("tool5");
    expect(text).toContain("Assistant: done");
  });
  it("finds a thread by the end of its id, and rejects ambiguous, unknown and short ids", async () => {
    await expect(route()("h", { action: "read", thread: "0000-aaaa1111" })).resolves.toBeTruthy();
    await expect(route()("h", { action: "read", thread: "1111" })).rejects.toThrow(/ambiguous/);
    await expect(route()("h", { action: "read", thread: "zzzz" })).rejects.toThrow(/No thread zzzz/);
    await expect(route()("h", { action: "read", thread: "aa" })).rejects.toThrow(/at least 4/);
  });
});
