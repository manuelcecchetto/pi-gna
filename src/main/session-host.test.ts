import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app" } }));

const fake = vi.hoisted(() => ({
  pis: [] as { opts: { sessionPath?: string }; handlers: { onRecords(r: unknown[]): void; onExit(e: unknown): void }; closed: boolean }[],
}));
vi.mock("./pi-process", () => ({
  PiProcess: class {
    closed = false;
    constructor(public opts: { sessionPath?: string }, public handlers: { onRecords(r: unknown[]): void; onExit(e: unknown): void }) {
      fake.pis.push(this);
    }
    send = async () => ({ type: "response", success: true, data: { sessionFile: this.opts.sessionPath } });
    respondUi = () => {};
    async close() {
      this.closed = true;
      this.handlers.onExit({ code: 0, signal: null, stderrTail: "" });
    }
  },
}));
vi.mock("./session-file", () => ({ readActiveBranch: async () => [] }));
vi.mock("./pi-settings", () => ({ projectTrust: async () => undefined }));


import type { Item, SessionState } from "../shared/session-state";
import type { AgentBridge } from "./bridge";
import { type SessionFeatures, SessionHost } from "./session-host";

const bridge = { url: "http://x", register: () => "token", unregister: () => {} } as unknown as AgentBridge;
const base: SessionFeatures = { kanban: false, laments: false, github: false, atp: false, computer: false, visuals: false };
const argsFor = (features: SessionFeatures, atp?: Parameters<SessionHost["piArgs"]>[2]) =>
  new SessionHost(() => {}, bridge, "/atp").piArgs("abcdef", undefined, atp, features).args;

describe("piArgs pr-review skill", () => {
  it("loads the bundled pr-review skill only when GitHub is on", () => {
    expect(argsFor(base).join(" ")).not.toContain("pr-review");
    const args = argsFor({ ...base, github: true });
    expect(args[args.indexOf("/app/resources/skills/pr-review") - 1]).toBe("--skill");
  });
});

describe("piArgs visuals prompt", () => {
  it("appends the visual prompt only when visuals is on", () => {
    expect(argsFor(base).join(" ")).not.toContain("pigna-visual-prompt.md");
    expect(argsFor({ ...base, visuals: true })).toContain("/app/resources/pigna-visual-prompt.md");
  });
  it("also appends it for ATP chats", () => {
    const args = argsFor({ ...base, visuals: true }, { role: "worker", plan: "/p/x.atp.json" } as never);
    expect(args).toContain("/app/resources/pigna-visual-prompt.md");
  });
});

// ── Registry: dedupe, leases, snapshots ──────────────────────────────────────

describe("session registry", () => {
  const rec = (type: string, extra: object = {}) => ({ type, ...extra });
  const userStart = (n: number) => rec("message_end", { message: { role: "user", content: `q${n}`, timestamp: n } });
  const assistantTurn = (n: number) => [
    rec("agent_start"),
    userStart(n),
    rec("message_start", { message: { role: "assistant", content: [], stopReason: "stop", timestamp: n } }),
    rec("message_end", { message: { role: "assistant", content: [{ type: "text", text: `a${n}` }], stopReason: "stop", timestamp: n } }),
    rec("agent_end", { messages: [] }),
    rec("agent_settled"),
  ];

  async function setup() {
    const { SessionHost: Host } = await import("./session-host");
    fake.pis.length = 0;
    const seen: { handle: string; events: { kind: string }[]; seq: number }[] = [];
    const globals: { kind: string }[] = [];
    let seq = 0;
    const host = new Host((batch) => {
      seq += batch.events.length;
      seen.push({ ...batch, seq });
      return seq;
    }, bridge, "/atp");
    host.onGlobal((event) => globals.push(event));
    return { host, seen, globals };
  }
  const A = { clientId: "a", actor: "desktop" } as const;
  const B = { clientId: "b", actor: "dev1" } as const;
  const request = { cwd: "/tmp", sessionPath: "/tmp/s.jsonl" };

  it("returns the live handle for an already open file instead of a second pi", async () => {
    const { host } = await setup();
    const first = await host.open(request, { client: A });
    const second = await host.open(request, { client: B });
    expect(second.handle).toBe(first.handle);
    expect(second.reused).toBe(true);
    expect(first.handle).toMatch(/^[a-z0-9]{6,32}$/);
    expect(fake.pis).toHaveLength(1);
    expect(host.presence(first.handle).map((c) => c.clientId)).toEqual(["a", "b"]);
  });

  it("stops a disposable pi when its last lease goes, but not a prompted one", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { client: A });
    await host.attach(handle, B);
    host.detach(handle, "a");
    expect(fake.pis[0]!.closed).toBe(false);
    host.detach(handle, "b");
    await Promise.resolve();
    expect(fake.pis[0]!.closed).toBe(true);

    const kept = await host.open({ cwd: "/tmp", sessionPath: "/tmp/t.jsonl" }, { client: A });
    await host.command(kept.handle, { type: "prompt", message: "hi" });
    host.detach(kept.handle, "a");
    await Promise.resolve();
    expect(fake.pis[1]!.closed).toBe(false);
  });

  it("keeps a held chat alive until the owner releases it", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { hold: "atp:T1" });
    await host.attach(handle, A);
    host.detach(handle, "a");
    expect(fake.pis[0]!.closed).toBe(false);
    host.release(handle, "atp:T1");
    await Promise.resolve();
    expect(fake.pis[0]!.closed).toBe(true);
  });

  it("broadcasts an explicit close before pi stops", async () => {
    const { host, seen, globals } = await setup();
    const { handle } = await host.open(request, { client: A });
    await host.command(handle, { type: "prompt", message: "hi" });
    await host.close(handle, { device: "dev1" });
    const kinds = seen.flatMap((batch) => batch.events.map((e) => e.kind));
    expect(kinds.indexOf("closed")).toBeGreaterThan(-1);
    expect(kinds.indexOf("closed")).toBeLessThan(kinds.indexOf("exit"));
    expect(globals.some((e) => e.kind === "chat.closed")).toBe(true);
  });

  it("pages snapshots by user turns and matches live reduction when events are applied", async () => {
    const { host, seen } = await setup();
    const { handle } = await host.open(request, { client: A });
    const pi = fake.pis[0]!;
    pi.handlers.onRecords([...assistantTurn(1), ...assistantTurn(2), ...assistantTurn(3)]);
    const live = host.stateOf(handle)!;
    const last = host.snapshot(handle, { turns: 1 })!;
    expect(last.turns).toEqual({ total: 3, from: 2 });
    expect((last.state.items as Item[]).filter((i) => i.kind === "user")).toHaveLength(1);
    const middle = host.snapshot(handle, { turns: 1, beforeTurn: 2 })!;
    expect(middle.turns).toEqual({ total: 3, from: 1 });
    expect(((middle.state.items as Item[]).find((i) => i.kind === "user") as { message: { content: string } }).message.content).toBe("q2");
    const all = host.snapshot(handle, { turns: 10 })!;
    expect(all.state.items).toEqual(live.items);

    // A snapshot cut mid-stream plus the events after it equals the live state.
    const { reduceHostEvent } = await import("../shared/session-state");
    const cut = host.snapshot(handle, { turns: 10 })!;
    pi.handlers.onRecords(assistantTurn(4));
    let replay = cut.state as unknown as SessionState;
    for (const batch of seen.filter((b) => b.handle === handle && b.seq > cut.seq)) {
      for (const event of batch.events) replay = reduceHostEvent(replay, event as never, 0);
    }
    expect(replay.items.map((i) => i.kind)).toEqual(host.stateOf(handle)!.items.map((i) => i.kind));
  });

  it("marks a run that ends unseen as unread, and viewing clears it; attention is published on change", async () => {
    const { host, globals } = await setup();
    const { handle } = await host.open(request, { client: A });
    fake.pis[0]!.handlers.onRecords(assistantTurn(1));
    expect(host.stateOf(handle)!.unread).toBe("done");
    host.viewing(handle, "a", true);
    expect(host.stateOf(handle)!.unread).toBeUndefined();
    fake.pis[0]!.handlers.onRecords(assistantTurn(2));
    expect(host.stateOf(handle)!.unread).toBeUndefined();
    const attentions = globals.filter((e) => e.kind === "attention") as unknown as { chats: { attention: string; settled?: unknown }[] }[];
    expect(attentions.some((e) => e.chats[0]?.attention === "unread")).toBe(true);
    expect(attentions.at(-1)!.chats[0]!.settled).toBeDefined();
  });
});
