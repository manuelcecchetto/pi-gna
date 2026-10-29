import { describe, expect, it, vi } from "vitest";
import type { AttentionSummary } from "../../shared/host-api";
import type { SessionSummary } from "../../shared/ipc";
import type { SessionEntry } from "../../shared/protocol";
import type { Item, RunOutcome } from "../../shared/session-state";
import { type BrainDeps, snapshot, VOICE_BRIEF, VoiceBrain } from "./brain";

const chat = (id: string, title: string, cwd: string, modifiedAt: number): SessionSummary => ({ path: `/s/${id}.jsonl`, id: `0199aaaa-0000-7000-8000-0000${id}`, cwd, title, named: true, createdAt: 0, modifiedAt, promptedAt: modifiedAt });
const CHATS = [chat("0000a1b2", "Fix flaky login test", "/code/app", 3), chat("0000c3d4", "Release v0.29.2", "/code/app", 2), chat("000099ff", "Other project", "/code/other", 9), chat("0000ffff", "Voice call", "/code/app", 10)];
const live = (path: string, attention: AttentionSummary["attention"], running: boolean) => ({ handle: path, cwd: "/code/app", sessionPath: path, title: "", listed: true, attention, running, dialogs: 0 });
const entry = (role: "user" | "assistant", text: string) =>
  ({ type: "message", id: text, parentId: null, timestamp: "2026-10-28T19:00:00.000Z", message: role === "user" ? { role, content: text, timestamp: 0 } : { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 } }) as unknown as SessionEntry;
const assistant = (text: string) => ({ kind: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) as unknown as Item;

function fakeHost() {
  const items: Item[] = [];
  const settle: ((handle: string, outcome: RunOutcome) => void)[] = [];
  const commands: Record<string, unknown>[] = [];
  const host = {
    open: vi.fn(async () => ({ handle: "h1" })),
    release: vi.fn(),
    stateOf: () => ({ items }),
    onSettled: (listener: (handle: string, outcome: RunOutcome) => void) => (settle.push(listener), () => settle.splice(settle.indexOf(listener), 1)),
    onExit: () => () => undefined,
    command: vi.fn(async (_handle: string, command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "get_state") return { success: true, data: { sessionFile: "/s/0000ffff.jsonl" } };
      if (command.type === "prompt")
        setTimeout(() => {
          items.push(assistant("Looking."), assistant("The login test is fixed."));
          for (const listener of [...settle]) listener("h1", "done");
        }, 1);
      return { success: true };
    }),
  };
  return { host, commands };
}

const deps = (host: ReturnType<typeof fakeHost>["host"]): BrainDeps => ({
  host: host as unknown as BrainDeps["host"],
  sessions: async () => [{ cwd: "/code", promptedAt: 0, sessions: CHATS }],
  live: () => [live(CHATS[0]!.path, "running", true), live(CHATS[1]!.path, "waiting", false)],
  read: async (path) => (path === CHATS[0]!.path ? [entry("user", "fix it"), entry("assistant", "Fixed: the cookie race.")] : []),
  model: async () => ({ provider: "openai-codex", id: "gpt-6.1-terra", thinking: "minimal" }),
  useModel: vi.fn(async () => undefined),
});

describe("snapshot", () => {
  it("names the project's chats newest first with status and the newest ones' last reply, not the voice chat itself", async () => {
    expect(await snapshot(deps(fakeHost().host), "/code/app", "/s/0000ffff.jsonl")).toBe(
      "Chats now, newest first (id, title, status):\n- 0000a1b2 Fix flaky login test (running)\n  last reply: Fixed: the cookie race.\n- 0000c3d4 Release v0.29.2 (waiting for the user)",
    );
  });
});

describe("VoiceBrain", () => {
  it("opens a Voice call chat on the voice model, briefs it once, and answers with its last reply", async () => {
    const { host, commands } = fakeHost();
    const d = deps(host);
    const brain = new VoiceBrain(d, "/code/app");
    expect(await brain.ask("Ciao.", new AbortController().signal)).toBe("The login test is fixed.");
    expect(d.useModel).toHaveBeenCalledWith("h1", { provider: "openai-codex", id: "gpt-6.1-terra", thinking: "minimal" });
    expect(commands).toContainEqual({ type: "set_session_name", name: "Voice call" });
    const prompts = () => commands.filter((command) => command.type === "prompt").map((command) => String(command.message));
    expect(prompts()[0]).toMatch(new RegExp(`^${VOICE_BRIEF.slice(0, 40)}`));
    expect(prompts()[0]).toMatch(/Chats now[\s\S]*\n\nCiao\.$/);
    await brain.ask("Thanks.", new AbortController().signal);
    expect(prompts()[1]).toMatch(/^Chats now/);
    expect(host.open).toHaveBeenCalledTimes(1);
    brain.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.release).toHaveBeenCalledWith("h1", expect.stringMatching(/^voice:/));
  });

  it("waits for a run already going in its chat (a chat answering it) before the user's turn", async () => {
    const { host, commands } = fakeHost();
    let running = true;
    const items: Item[] = [];
    const settle: ((handle: string, outcome: RunOutcome) => void)[] = [];
    Object.assign(host, {
      stateOf: () => ({ items, running }),
      onSettled: (listener: (handle: string, outcome: RunOutcome) => void) => (settle.push(listener), () => settle.splice(settle.indexOf(listener), 1)),
    });
    host.command.mockImplementation(async (_handle: string, command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "prompt") {
        expect(running).toBe(false);
        setTimeout(() => (items.push(assistant("Done.")), [...settle].forEach((listener) => listener("h1", "done"))), 1);
      }
      return command.type === "get_state" ? { success: true, data: { sessionFile: "/s/0000ffff.jsonl" } } : { success: true };
    });
    const answer = new VoiceBrain(deps(host), "/code/app").ask("Hi.", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(commands.some((command) => command.type === "prompt")).toBe(false);
    running = false;
    [...settle].forEach((listener) => listener("h1", "done"));
    expect(await answer).toBe("Done.");
  });

  it("stops the chat's run when the call stops it", async () => {
    const { host, commands } = fakeHost();
    host.command.mockImplementation(async (_handle: string, command: Record<string, unknown>) => {
      commands.push(command);
      return command.type === "get_state" ? { success: true, data: { sessionFile: "/s/0000ffff.jsonl" } } : { success: true };
    });
    const brain = new VoiceBrain(deps(host), "/code/app");
    const stop = new AbortController();
    const answer = brain.ask("Do a long thing.", stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stop.abort();
    await expect(answer).rejects.toThrow("stopped");
    expect(commands).toContainEqual({ type: "abort" });
  });
});
