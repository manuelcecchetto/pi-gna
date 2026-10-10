import { describe, expect, it } from "vitest";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Command {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

// Not a literal path: tsc would type-check the extension, whose pi types this project does not install.
const path = "../../resources/fast-extension";

async function load(branch: unknown[] = []) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const entries: unknown[] = [];
  const notes: string[] = [];
  const statuses: Record<string, string | undefined> = {};
  const { default: register } = (await import(path)) as { default: (pi: unknown) => void };
  register({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  });
  const ctx = (provider: string) => ({
    model: { provider, id: `${provider}-model` },
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notes.push(message), setStatus: (key: string, text?: string) => (statuses[key] = text) },
  });
  handlers.get("session_start")!({ type: "session_start" }, ctx("openai"));
  const request = (provider: string) => handlers.get("before_provider_request")!({ payload: { model: "m" } }, ctx(provider));
  const fast = (args: string, provider = "openai-codex") => commands.get("fast")!.handler(args, ctx(provider));
  return { request, fast, entries, notes, statuses };
}

describe("fast extension", () => {
  it("adds the priority tier to GPT requests only while on", async () => {
    const chat = await load();
    expect(chat.request("openai-codex")).toBeUndefined();
    await chat.fast("");
    expect(chat.statuses.fast).toBe("on");
    expect(chat.request("openai-codex")).toEqual({ model: "m", service_tier: "priority" });
    expect(chat.request("openai")).toEqual({ model: "m", service_tier: "priority" });
    expect(chat.request("anthropic")).toBeUndefined();
    await chat.fast("");
    expect(chat.statuses.fast).toBeUndefined();
    expect(chat.request("openai")).toBeUndefined();
    expect(chat.entries).toEqual([
      { type: "custom", customType: "pigna-fast", data: { on: true } },
      { type: "custom", customType: "pigna-fast", data: { on: false } },
    ]);
  });

  it("restores the chat's last choice when it opens", async () => {
    const chat = await load([
      { type: "custom", customType: "pigna-fast", data: { on: true } },
      { type: "message" },
    ]);
    expect(chat.request("openai")).toEqual({ model: "m", service_tier: "priority" });
    expect(chat.statuses.fast).toBe("on");
  });

  // The zap shows a change, so a toggle on a GPT model says nothing; a status check, a non-GPT model and a typo do.
  it("speaks only for status, a non-GPT model and bad input; saves only changes", async () => {
    const chat = await load();
    await chat.fast("status");
    await chat.fast("off");
    await chat.fast("on");
    expect(chat.notes).toEqual(["Fast mode is off."]);
    await chat.fast("on", "anthropic");
    expect(chat.entries).toHaveLength(1);
    expect(chat.notes[1]).toContain("anthropic-model is unaffected");
    await chat.fast("maybe");
    expect(chat.notes[2]).toBe("Usage: /fast [on|off|status]");
  });
});
