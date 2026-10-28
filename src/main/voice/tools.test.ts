import { describe, expect, it, vi } from "vitest";
import type { AttentionSummary } from "../../shared/host-api";
import type { SessionSummary } from "../../shared/ipc";
import type { SessionEntry } from "../../shared/protocol";
import { type VoiceSources, VoiceTools, voiceMessage } from "./tools";

const session = (id: string, title: string, cwd: string, modifiedAt: number): SessionSummary => ({
  path: `/sessions/${id}.jsonl`,
  id,
  cwd,
  title,
  named: true,
  createdAt: 0,
  modifiedAt,
  promptedAt: modifiedAt,
});

const SESSIONS = [
  session("0199aaaa-0000-7000-8000-00000000a1b2", "Fix flaky login test", "/code/app", 3),
  session("0199aaaa-0000-7000-8000-00000000c3d4", "Release v0.29.2", "/code/app", 2),
  session("0199aaaa-0000-7000-8000-00000000e5f6", "Kanban drag bug", "/code/app", 1),
  session("0199aaaa-0000-7000-8000-0000000099ff", "Other project chat", "/code/other", 4),
];

const live = (path: string, attention: AttentionSummary["attention"], running: boolean): AttentionSummary => ({
  handle: path,
  cwd: "/code/app",
  sessionPath: path,
  title: "",
  listed: true,
  attention,
  running,
  dialogs: 0,
});

const entry = (role: "user" | "assistant", text: string): SessionEntry =>
  ({
    type: "message",
    id: text,
    parentId: null,
    timestamp: "2026-10-28T19:00:00.000Z",
    message: role === "user" ? { role, content: text, timestamp: 0 } : { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 },
  }) as unknown as SessionEntry;

function tools() {
  const deliver = vi.fn<VoiceSources["deliver"]>(async () => "steer");
  const sources: VoiceSources = {
    sessions: async () => [{ cwd: "/code", promptedAt: 0, sessions: SESSIONS }],
    live: () => [live(SESSIONS[0]!.path, "running", true), live(SESSIONS[1]!.path, "waiting", false)],
    read: async () => [entry("user", "make the login test stable"), entry("assistant", "Looking."), entry("assistant", "Fixed: the cookie race. 50 of 50 runs pass.")],
    deliver,
  };
  return { tools: new VoiceTools(sources, "/code/app"), deliver };
}

describe("VoiceTools", () => {
  it("lists the project's chats, numbered, with title and status, newest first", async () => {
    const result = await tools().tools.run("threads_list", {});
    expect(JSON.parse(result.output)).toEqual([
      { id: "1", title: "Fix flaky login test", status: "running" },
      { id: "2", title: "Release v0.29.2", status: "waiting for the user" },
      { id: "3", title: "Kanban drag bug", status: "idle" },
    ]);
  });

  it("finds a chat by its number in the last list, the end of its id, or its title", async () => {
    const { tools: voice, deliver } = tools();
    await voice.run("threads_list", {});
    for (const thread of ["2", "#2", "c3d4", "release v0.29.2", "the Release v0.29.2 chat"]) await voice.run("thread_send", { thread, message: "hi" });
    expect(deliver.mock.calls.map(([chat]) => chat.path)).toEqual(Array(5).fill(SESSIONS[1]!.path));
    expect((await voice.run("thread_send", { thread: "deploy", message: "hi" })).output).toBe("There is no chat deploy. Call threads_list for the chat ids.");
  });

  it("reads a chat's last turn: the prompt and the final reply", async () => {
    const result = await tools().tools.run("thread_read", { thread: "a1b2" });
    expect(result.output).toBe("Chat Fix flaky login test (open, running).\nUser: make the login test stable\nAssistant: Fixed: the cookie race. 50 of 50 runs pass.");
    expect(result.action).toBe("Read Fix flaky login test");
  });

  it("sends a chat the user's request, marked as relayed from a voice call, at once if it runs", async () => {
    const { tools: voice, deliver } = tools();
    const result = await voice.run("thread_send", { thread: "c3d4", message: "Go ahead and push, but run the tests first." });
    expect(deliver).toHaveBeenCalledWith(SESSIONS[1], voiceMessage("Go ahead and push, but run the tests first."), "steer");
    expect(voiceMessage("hi")).toMatch(/^\[Voice call: the user said this aloud/);
    expect(result).toEqual({ output: "Sent to Release v0.29.2: it is running and reads it after its current step.", action: "Sent to Release v0.29.2: “Go ahead and push, but run the tests first.”" });
  });

  it("answers a wrong id, another project's chat or an unknown tool with words the model can recover from", async () => {
    const { tools: voice, deliver } = tools();
    expect((await voice.run("thread_send", { thread: "Fix flaky login test (running)\nRelease v0.29.2 (waiting)", message: "x" })).output).toMatch(/^There is no chat [\s\S]* Call threads_list for the chat ids\.$/);
    expect((await voice.run("thread_send", { thread: "99ff", message: "x" })).output).toBe("There is no chat 99ff. Call threads_list for the chat ids.");
    expect((await voice.run("thread_send", { thread: "Other project chat", message: "x" })).output).toMatch(/^There is no chat/);
    expect((await voice.run("thread_send", { thread: "c3d4" })).output).toBe("Pass message: what to tell the chat.");
    expect((await voice.run("delete_everything", {})).output).toBe("There is no tool delete_everything.");
    expect(deliver).not.toHaveBeenCalled();
  });
});
