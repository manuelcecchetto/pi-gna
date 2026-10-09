import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app" } }));
vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const fake = vi.hoisted(() => ({
  sent: [] as { type: string; message?: string }[],
  delay: 0,
  pis: [] as { handlers: { onRecords(r: unknown[]): void } }[],
}));
vi.mock("./pi-process", () => ({
  PiProcess: class {
    constructor(public opts: { sessionPath?: string }, public handlers: { onRecords(r: unknown[]): void; onExit(e: unknown): void }) {
      fake.pis.push(this);
    }
    send = async (command: { type: string; message?: string }) => {
      fake.sent.push(command);
      if (fake.delay) await new Promise((resolve) => setTimeout(resolve, fake.delay));
      return { type: "response", success: true, data: command.type === "clear_queue" ? { steering: ["s1"], followUp: [] } : { sessionFile: this.opts.sessionPath } };
    };
    respondUi = () => undefined;
    async close() {
      this.handlers.onExit({ code: 0, signal: null, stderrTail: "" });
    }
  },
}));
vi.mock("./session-file", () => ({ readActiveBranch: async () => [] }));
vi.mock("./pi-settings", () => ({ projectTrust: async () => undefined }));

import type { AgentBridge } from "./bridge";
import { BoardStore } from "./board";
import { SessionHost } from "./session-host";

// The desktop window and two phones against one host. The rules under test live in the host (main), not in any client.
const bridge = { url: "http://x", start: async () => {}, register: () => "token", unregister: () => {} } as unknown as AgentBridge;
const DESKTOP = { clientId: "desktop", actor: "desktop" } as const;
const P1 = { clientId: "p1", actor: "dev1", caller: { device: "dev1" } } as const;
const P2 = { clientId: "p2", actor: "dev2", caller: { device: "dev2" } } as const;
const as = (c: typeof P1 | typeof P2) => ({ caller: c.caller, clientId: c.clientId, bootId: "b" }) as const;
// pi's own startup get_state is not a client command.
const sent = () => fake.sent.filter((c) => c.type !== "get_state");
const request = { cwd: "/tmp", sessionPath: "/tmp/m.jsonl" };

async function setup() {
  fake.pis.length = 0;
  fake.sent.length = 0;
  fake.delay = 0;
  const events: { kind: string; [key: string]: unknown }[] = [];
  const globals: { kind: string; [key: string]: unknown }[] = [];
  const host = new SessionHost((batch) => void events.push(...(batch.events as never[])), bridge, "/atp");
  host.onGlobal((event) => globals.push(event as never));
  const { handle } = await host.open(request, { client: DESKTOP });
  return { host, handle, events, globals, pi: fake.pis[0]! };
}

describe("prompts from several clients", () => {
  it("reach pi in call order while idle, and nothing is lost or merged", async () => {
    const { host, handle } = await setup();
    fake.delay = 3;
    await Promise.all([
      host.command(handle, { type: "prompt", message: "from desktop" }, undefined),
      host.command(handle, { type: "prompt", message: "from p1" }, as(P1)),
      host.command(handle, { type: "prompt", message: "from p2" }, as(P2)),
    ]);
    expect(sent().filter((c) => c.type === "prompt").map((c) => c.message)).toEqual(["from desktop", "from p1", "from p2"]);
  });

  it("while running, each client's steer and follow-up stay in the kind they asked for, in order", async () => {
    const { host, handle, pi } = await setup();
    pi.handlers.onRecords([{ type: "agent_start" }]);
    fake.delay = 2;
    await Promise.all([
      host.command(handle, { type: "steer", message: "now" }, as(P1)),
      host.command(handle, { type: "follow_up", message: "later" }, as(P2)),
      host.command(handle, { type: "steer", message: "also now" }, undefined),
    ]);
    expect(sent().map((c) => `${c.type}:${c.message}`)).toEqual(["steer:now", "follow_up:later", "steer:also now"]);
  });

  it("serializes an abort against another client's steer: the steer lands whole, before or after, never inside", async () => {
    const { host, handle, pi } = await setup();
    pi.handlers.onRecords([{ type: "agent_start" }]);
    fake.delay = 4;
    const [restored] = await Promise.all([host.interrupt(handle), host.command(handle, { type: "steer", message: "late" }, as(P1))]);
    expect(restored).toEqual(["s1"]);
    expect(sent().map((c) => c.type)).toEqual(["clear_queue", "abort", "steer"]);
    // Both clients see the same chat: one pi, one history.
    expect(fake.pis).toHaveLength(1);
  });

  it("applies concurrent queue edits one at a time", async () => {
    const { host, handle, pi } = await setup();
    pi.handlers.onRecords([{ type: "agent_start" }]);
    fake.delay = 2;
    const results = await Promise.all([
      host.editQueue(handle, { type: "remove", kind: "steering", text: "s1" }),
      host.editQueue(handle, { type: "remove", kind: "steering", text: "s1" }),
    ]);
    expect(results).toEqual([true, true]);
    // Each edit is clear_queue then its re-adds, with no other edit's commands in between.
    expect(sent().map((c) => c.type)).toEqual(["clear_queue", "clear_queue"]);
  });
});

describe("one dialog, two answers", () => {
  it("takes the first and refuses the second with already_answered; both see who won", async () => {
    const { host, handle, events, pi } = await setup();
    pi.handlers.onRecords([{ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run?" }]);
    host.respondDialog(handle, { type: "extension_ui_response", id: "d1", confirmed: true }, as(P2));
    expect(() => host.respondDialog(handle, { type: "extension_ui_response", id: "d1", confirmed: false }, as(P1))).toThrowError(expect.objectContaining({ code: "already_answered" }));
    expect(events.filter((e) => e.kind === "dialog_resolved")).toEqual([{ kind: "dialog_resolved", id: "d1", by: { device: "dev2" }, outcome: "answered" }]);
  });
});

describe("leases and closing", () => {
  it("lets a phone leave while the desktop keeps the chat; the last one out stops a disposable chat", async () => {
    const { host, handle } = await setup();
    await host.attach(handle, { clientId: "p1", actor: P1.actor });
    host.detach(handle, "p1");
    expect(host.stateOf(handle)).toBeDefined();
    expect(host.presence(handle).map((c) => c.clientId)).toEqual(["desktop"]);
    host.detach(handle, "desktop");
    await Promise.resolve();
    expect(host.stateOf(handle)).toBeUndefined();
  });

  it("an explicit close by one client reaches every client, as an event on the chat and a global one", async () => {
    const { host, handle, events, globals } = await setup();
    await host.attach(handle, { clientId: "p1", actor: P1.actor });
    await host.attach(handle, { clientId: "p2", actor: P2.actor });
    await host.close(handle, P1.caller);
    expect(events.find((e) => e.kind === "closed")).toMatchObject({ by: P1.caller });
    expect(globals.find((e) => e.kind === "chat.closed")).toMatchObject({ handle });
    expect(host.stateOf(handle)).toBeUndefined();
  });

  it("shows a chat started on a phone to the desktop: a global chat.opened, and the same pi when the desktop opens it", async () => {
    fake.pis.length = 0;
    const globals: { kind: string; [key: string]: unknown }[] = [];
    const host = new SessionHost(() => undefined, bridge, "/atp");
    host.onGlobal((event) => globals.push(event as never));
    const phone = await host.open({ cwd: "/tmp", sessionPath: "/tmp/phone.jsonl" }, { client: { clientId: "p1", actor: P1.actor } });
    expect(globals.find((e) => e.kind === "chat.opened")).toMatchObject({ handle: phone.handle, sessionPath: "/tmp/phone.jsonl" });
    expect(host.attentionAll().map((c) => c.handle)).toContain(phone.handle);
    const desktop = await host.open({ cwd: "/tmp", sessionPath: "/tmp/phone.jsonl" }, { client: DESKTOP });
    expect(desktop).toMatchObject({ handle: phone.handle, reused: true });
    expect(fake.pis).toHaveLength(1);
  });

  it("tracks who is looking per client, so the host can close a chat only when nobody is", async () => {
    const { host, handle } = await setup();
    await host.attach(handle, { clientId: "p1", actor: P1.actor });
    host.viewing(handle, "desktop", true);
    host.viewing(handle, "p1", true);
    host.viewing(handle, "desktop", false);
    const viewing = () => host.presence(handle).filter((c) => c.viewing).map((c) => c.clientId);
    expect(viewing()).toEqual(["p1"]);
    host.viewing(handle, "p1", false);
    expect(viewing()).toEqual([]);
  });
});

describe("card edits from several clients", () => {
  const store = async () => new BoardStore(join(await mkdtemp(join(tmpdir(), "pigna-mc-")), "board.json"), () => undefined);

  it("gives conflicting title edits from the same revision exactly one winner and one conflict error", async () => {
    const board = await store();
    await board.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    const seen = (await board.get()).rev;
    const results = await Promise.allSettled([
      board.apply({ type: "edit", id: "aaaaaa", title: "From p1" }, seen),
      board.apply({ type: "edit", id: "aaaaaa", title: "From p2" }, seen),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "conflict", status: 409 });
    expect((await board.get()).cards[0]?.title).toBe("From p1");
  });

  it("lets a title edit and a notes edit from the same revision both land", async () => {
    const board = await store();
    await board.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    const seen = (await board.get()).rev;
    await Promise.all([board.apply({ type: "edit", id: "aaaaaa", title: "T" }, seen), board.apply({ type: "edit", id: "aaaaaa", notes: "N" }, seen)]);
    expect((await board.get()).cards[0]).toMatchObject({ title: "T", notes: "N" });
  });

  it("keeps concurrent moves last-writer-wins and every card exactly once", async () => {
    const board = await store();
    await board.apply({ type: "add", id: "aaaaaa", title: "One", cwd: "/repo" });
    await board.apply({ type: "add", id: "bbbbbb", title: "Two", cwd: "/repo" });
    const seen = (await board.get()).rev;
    await Promise.all([
      board.apply({ type: "move", id: "aaaaaa", column: "done" }, seen),
      board.apply({ type: "move", id: "aaaaaa", column: "in_progress" }, seen),
      board.apply({ type: "move", id: "bbbbbb", column: "in_review" }, seen),
    ]);
    const { cards } = await board.get();
    expect(cards.map((c) => c.id).sort()).toEqual(["aaaaaa", "bbbbbb"]);
    expect(cards.find((c) => c.id === "aaaaaa")?.column).toBe("in_progress");
    expect(cards.find((c) => c.id === "bbbbbb")?.column).toBe("in_review");
  });
});
