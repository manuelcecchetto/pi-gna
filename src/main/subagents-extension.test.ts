import { afterEach, describe, expect, it, vi } from "vitest";
import { liveSubagents } from "../shared/subagents";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

// Not a literal path: tsc would type-check the extension, whose pi types this project does not install.
const path = "../../resources/subagents-extension";
const SERVICE = Symbol.for("@gotgenes/pi-subagents:service");

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "general-purpose",
  description: `Agent ${id}`,
  status: "running",
  isBackground: true,
  toolUses: 2,
  startedAt: 100,
  lifetimeUsage: { input: 10, output: 5, cacheWrite: 1 },
  compactionCount: 0,
  ...extra,
});

async function load(service: unknown) {
  (globalThis as Record<symbol, unknown>)[SERVICE] = service;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  const mod = (await import(path)) as { default: (pi: unknown) => void; readTail: (text: string) => unknown };
  mod.default({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  });
  const ctx = { ui: { setStatus: (_key: string, text?: string) => statuses.push(text), notify: (message: string) => notes.push(message) } };
  handlers.get("session_start")!({ type: "session_start" }, ctx);
  return { handlers, commands, statuses, notes, ctx, readTail: mod.readTail };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[SERVICE];
});

describe("subagents extension", () => {
  it("reports the package's agents as the status, again only when they change", async () => {
    vi.useFakeTimers();
    const agents = [record("a1")];
    const chat = await load({ listAgents: () => agents, abort: () => true, steer: async () => true });
    expect(liveSubagents(chat.statuses[0])).toEqual([
      { id: "a1", description: "Agent a1", type: "general-purpose", status: "running", startedAt: 100, toolUses: 2, tokens: 16 },
    ]);
    vi.advanceTimersByTime(3000);
    expect(chat.statuses).toHaveLength(1);
    agents[0] = record("a1", { status: "completed", completedAt: 900 });
    vi.advanceTimersByTime(1000);
    expect(liveSubagents(chat.statuses.at(-1))[0]).toMatchObject({ status: "completed", endedAt: 900 });
    chat.handlers.get("session_shutdown")!({}, chat.ctx);
    agents.pop();
    vi.advanceTimersByTime(5000);
    expect(chat.statuses).toHaveLength(2);
  });

  it("keeps the chat's service when a child session publishes its own, and when the child removes it", async () => {
    vi.useFakeTimers();
    const chat = await load({ listAgents: () => [record("a1")], abort: () => true, steer: async () => true });
    // pi-subagents loads into each child session: its factory publishes the child's empty service, its shutdown deletes it.
    (globalThis as Record<symbol, unknown>)[SERVICE] = { listAgents: () => [], abort: () => false, steer: async () => false };
    vi.advanceTimersByTime(2000);
    delete (globalThis as Record<symbol, unknown>)[SERVICE];
    vi.advanceTimersByTime(2000);
    expect(chat.statuses).toHaveLength(1);
    expect(liveSubagents(chat.statuses[0]).map((agent) => agent.id)).toEqual(["a1"]);
    await chat.commands.get("subagent")!.handler("stop a1", chat.ctx);
    expect(chat.notes).toEqual([]);
  });

  it("stops and steers through the package, and says when it cannot", async () => {
    const calls: string[] = [];
    const chat = await load({ listAgents: () => [], abort: (id: string) => (calls.push(`abort ${id}`), id === "a1"), steer: async (id: string, message: string) => (calls.push(`steer ${id} ${message}`), false) });
    const run = (args: string) => chat.commands.get("subagent")!.handler(args, chat.ctx);
    await run("stop a1");
    await run("stop a2");
    await run("steer a1 check the logs");
    await run("nonsense");
    expect(calls).toEqual(["abort a1", "abort a2", "steer a1 check the logs"]);
    expect(chat.notes).toEqual(["That subagent is not running.", "That subagent is not running, so it cannot be steered.", expect.stringContaining("Usage")]);
    // An agent list that empties clears the status.
    expect(chat.statuses).toEqual([]);
  });

  it("says nothing without pi-subagents, and the command tells why", async () => {
    const chat = await load(undefined);
    expect(chat.statuses).toEqual([]);
    await chat.commands.get("subagent")!.handler("stop a1", chat.ctx);
    expect(chat.notes).toEqual([expect.stringContaining("not installed")]);
  });

  it("reads the latest tool call and model from a file's end, skipping a cut first line", async () => {
    const chat = await load(undefined);
    const text = [
      '"role":"assistant" cut off',
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "m1", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "m2", content: [{ type: "text", text: "thinking about it" }] } }),
    ].join("\n");
    expect(chat.readTail(text)).toEqual({ last: { name: "read", args: { path: "a.ts" } }, model: "p/m2" });
  });
});
