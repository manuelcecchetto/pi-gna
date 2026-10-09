import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app" } }));

const fake = vi.hoisted(() => ({
  send: (async (_command: unknown, _pi: unknown) => undefined) as (command: unknown, pi: unknown) => Promise<unknown>,
  responded: [] as unknown[],
  pis: [] as { opts: { sessionPath?: string }; handlers: { onRecords(r: unknown[]): void; onExit(e: unknown): void }; closed: boolean; close(): Promise<void> }[],
}));
vi.mock("./pi-process", () => ({
  PiProcess: class {
    closed = false;
    constructor(public opts: { sessionPath?: string }, public handlers: { onRecords(r: unknown[]): void; onExit(e: unknown): void }) {
      fake.pis.push(this);
    }
    send = async (command: unknown) => (await fake.send(command, this)) ?? { type: "response", success: true, data: { sessionFile: this.opts.sessionPath } };
    respondUi = (response: unknown) => fake.responded.push(response);
    async close() {
      this.closed = true;
      this.handlers.onExit({ code: 0, signal: null, stderrTail: "" });
    }
  },
}));
const file = vi.hoisted(() => ({ read: async (_path: string): Promise<unknown[]> => [] }));
vi.mock("./session-file", () => ({ readActiveBranch: (path: string) => file.read(path) }));
// Busy by default, so that only the spare pi's tests start one (2 s after a chat a client opened is ready).
const machine = vi.hoisted(() => ({ load: Number.POSITIVE_INFINITY, inputs: "inputs-1" }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), loadavg: () => [machine.load, 0, 0], availableParallelism: () => 8 }));
vi.mock("./pi-settings", () => ({ projectTrust: async () => undefined, piInputs: async () => machine.inputs }));


import type { Item, SessionState } from "../shared/session-state";
import type { AgentBridge } from "./bridge";
import { type SessionFeatures, SessionHost } from "./session-host";

const bridge = { url: "http://x", start: async () => {}, register: vi.fn((_handle: string) => "token"), unregister: () => {}, rename: vi.fn() };
const base: SessionFeatures = { kanban: false, laments: false, github: false, atp: false, computer: false, visuals: false };
const argsFor = (features: SessionFeatures, atp?: Parameters<SessionHost["piArgs"]>[2]) =>
  new SessionHost(() => {}, bridge as unknown as AgentBridge, "/atp").piArgs("abcdef", undefined, atp, features).args;

describe("piArgs pr-review skill", () => {
  it("loads the bundled pr-review skill only when GitHub is on", () => {
    expect(argsFor(base).join(" ")).not.toContain("pr-review");
    const args = argsFor({ ...base, github: true });
    expect(args[args.indexOf("/app/resources/skills/pr-review") - 1]).toBe("--skill");
  });
});

describe("piArgs visuals prompt", () => {
  it("loads the visual extension only when visuals is on", () => {
    expect(argsFor(base).join(" ")).not.toContain("visual");
    const args = argsFor({ ...base, visuals: true });
    expect(args[args.indexOf("/app/resources/visual-extension.ts") - 1]).toBe("-e");
  });
  it("also loads it for ATP chats", () => {
    const args = argsFor({ ...base, visuals: true }, { role: "worker", plan: "/p/x.atp.json" } as never);
    expect(args).toContain("/app/resources/visual-extension.ts");
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

  async function setup(features?: SessionFeatures) {
    const { SessionHost: Host } = await import("./session-host");
    fake.pis.length = 0;
    const seen: { handle: string; events: { kind: string }[]; seq: number }[] = [];
    const globals: { kind: string }[] = [];
    let seq = 0;
    const host = new Host((batch) => {
      seq += batch.events.length;
      seen.push({ ...batch, seq });
      return seq;
    }, bridge as unknown as AgentBridge, "/atp", features && (async () => features));
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

  it("joins a live chat without reading its file again: the host's state is newer, and comes through attach", async () => {
    const { host } = await setup();
    let reads = 0;
    file.read = async () => (reads++, []);
    try {
      const { handle } = await host.open(request, { client: A });
      fake.pis[0]!.handlers.onRecords(assistantTurn(1));
      const second = await host.open(request, { client: B });
      expect(second).toEqual({ handle, reused: true });
      expect(reads).toBe(1);
      expect(host.presence(handle).map((c) => c.clientId)).toEqual(["a", "b"]);
      expect(host.stateOf(handle)!.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    } finally {
      file.read = async () => [];
    }
  });

  describe("pi boots while the session file is read", () => {
    const old = { type: "message", id: "e1", parentId: null, timestamp: "2026-10-08T00:00:00.000Z", message: { role: "user", content: "old", timestamp: 1 } };
    /** The next reads wait for `finish` (or `fail`); `reads` counts them. */
    function slowFile() {
      const read = { reads: 0, finish: (_entries: unknown[]) => {}, fail: (_error: Error) => {} };
      file.read = () => {
        read.reads++;
        return new Promise((resolve, reject) => {
          read.finish = resolve;
          read.fail = reject;
        });
      };
      return read;
    }
    const afterRead = () => (file.read = async () => []);

    it("starts pi before the read, and a second open of the file joins it once the history is in", async () => {
      const { host, globals } = await setup();
      const read = slowFile();
      try {
        const first = host.open(request, { client: A });
        const second = host.open(request, { client: B });
        await vi.waitFor(() => expect(fake.pis).toHaveLength(1));
        expect(globals.some((event) => event.kind === "chat.opened")).toBe(false);
        expect(host.attentionAll()).toEqual([]);
        read.finish([old]);
        // Either open may start pi (their checks before it race on the file system); the other joins it.
        const results = await Promise.all([first, second]);
        const a = results.find((result) => !result.reused)!;
        expect(results.find((result) => result.reused)).toEqual({ handle: a.handle, reused: true });
        expect(a).toEqual({ handle: a.handle });
        expect(read.reads).toBe(1);
        expect(fake.pis).toHaveLength(1);
        expect(host.stateOf(a.handle)!.items.map((item) => item.kind)).toEqual(["user"]);
        expect(host.stateOf(a.handle)!.phase).toBe("ready");
        expect(host.presence(a.handle).map((c) => c.clientId).sort()).toEqual(["a", "b"]);
      } finally {
        afterRead();
      }
    });

    it("applies what pi says during the read after the history, in order", async () => {
      const { host, seen } = await setup();
      const read = slowFile();
      try {
        const opening = host.open(request, { client: A });
        await vi.waitFor(() => expect(fake.pis).toHaveLength(1));
        await Promise.resolve();
        fake.pis[0]!.handlers.onRecords(assistantTurn(1));
        expect(seen).toEqual([]);
        read.finish([old]);
        const { handle } = await opening;
        const state = host.stateOf(handle)!;
        expect(state.items.map((item) => (item.kind === "user" ? `user ${String(item.message.content)}` : item.kind))).toEqual(["user old", "user q1", "assistant"]);
        expect(state.phase).toBe("ready");
        const kinds = seen.flatMap((batch) => batch.events.map((e) => (e.kind === "rpc" ? (e as unknown as { record: { type: string } }).record.type : e.kind)));
        expect(kinds).toEqual(["lease", "ready", ...assistantTurn(1).map((record) => record.type)]);
      } finally {
        afterRead();
      }
    });

    it("opens, then closes, a chat whose pi exits during the read", async () => {
      const { host, seen, globals } = await setup();
      const read = slowFile();
      try {
        const opening = host.open(request, { client: A });
        await vi.waitFor(() => expect(fake.pis).toHaveLength(1));
        await fake.pis[0]!.close();
        expect(globals).toEqual([]);
        expect(host.size).toBe(1);
        read.finish([old]);
        const { handle } = await opening;
        const order = globals.map((event) => event.kind);
        expect(order.indexOf("chat.opened")).toBeGreaterThan(-1);
        expect(order.indexOf("chat.opened")).toBeLessThan(order.indexOf("chat.closed"));
        expect(seen.flatMap((batch) => batch.events.map((e) => e.kind)).at(-1)).toBe("exit");
        expect(host.stateOf(handle)).toBeUndefined();
        expect(host.size).toBe(0);
      } finally {
        afterRead();
      }
    });

    it("answers a paged open with the snapshot taken before what pi said during the read, which follows it", async () => {
      const { host, seen } = await setup();
      const read = slowFile();
      try {
        const opening = host.open(request, { client: A }, { turns: 1, outline: true });
        await vi.waitFor(() => expect(fake.pis).toHaveLength(1));
        await Promise.resolve();
        fake.pis[0]!.handlers.onRecords(assistantTurn(1));
        read.finish([old]);
        const { handle, snapshot } = await opening;
        expect(snapshot!.state.phase).toBe("starting");
        expect((snapshot!.state.items as Item[]).map((item) => item.kind)).toEqual(["user"]);
        expect(snapshot!.outline).toEqual([]);
        // Replaying what came after the snapshot gives the host's state.
        const { reduceHostEvent } = await import("../shared/session-state");
        let replay = snapshot!.state as unknown as SessionState;
        for (const batch of seen.filter((b) => b.handle === handle && b.seq > snapshot!.seq)) for (const event of batch.events) replay = reduceHostEvent(replay, event as never, 0);
        expect(replay.items.map((item) => item.kind)).toEqual(["user", "user", "assistant"]);
        expect(replay.phase).toBe("ready");
      } finally {
        afterRead();
      }
    });

    it("keeps the history in the snapshot of a chat whose pi exits during the read", async () => {
      const { host, seen } = await setup();
      const read = slowFile();
      try {
        const opening = host.open(request, { client: A }, { turns: 5, outline: true });
        await vi.waitFor(() => expect(fake.pis).toHaveLength(1));
        await fake.pis[0]!.close();
        read.finish([old]);
        const { handle, snapshot } = await opening;
        expect((snapshot!.state.items as Item[]).map((item) => item.kind)).toEqual(["user"]);
        const exit = seen.find((batch) => batch.handle === handle && batch.events.some((event) => event.kind === "exit"))!;
        expect(exit.seq).toBeGreaterThan(snapshot!.seq);
        expect(host.stateOf(handle)).toBeUndefined();
      } finally {
        afterRead();
      }
    });

    it("stops the booting pi without a trace when the file cannot be read", async () => {
      const { host, seen, globals } = await setup();
      const unregister = vi.spyOn(bridge, "unregister");
      const read = slowFile();
      try {
        const opening = host.open(request, { client: A });
        await vi.waitFor(() => expect(fake.pis).toHaveLength(1));
        read.fail(new Error("ENOENT"));
        await expect(opening).rejects.toThrow("ENOENT");
        expect(fake.pis[0]!.closed).toBe(true);
        expect(unregister).toHaveBeenCalled();
        expect(host.size).toBe(0);
        expect(seen).toEqual([]);
        expect(globals).toEqual([]);
        afterRead();
        await host.open(request, { client: A });
        expect(fake.pis).toHaveLength(2);
      } finally {
        unregister.mockRestore();
        afterRead();
      }
    });
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

  it("makes a page fewer turns when they are big, but never none", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { client: A });
    const big = (n: number, size: number) => [
      rec("agent_start"),
      userStart(n),
      rec("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name: "read", arguments: {} }], stopReason: "toolUse", timestamp: n } }),
      rec("tool_execution_end", { toolCallId: `t${n}`, toolName: "read", result: { content: [{ type: "text", text: "x".repeat(size) }] }, isError: false }),
      rec("agent_end", { messages: [] }),
      rec("agent_settled"),
    ];
    fake.pis[0]!.handlers.onRecords([...big(1, 50_000), ...big(2, 10), ...big(3, 30_000), ...big(4, 10), ...big(5, 10)]);
    expect(host.snapshot(handle, { turns: 10 })!.turns).toEqual({ total: 5, from: 0 });
    // The third turn's 30 kB result does not fit in 20 kB beside the last two; in 40 kB only the first turn's does not.
    expect(host.snapshot(handle, { turns: 10, bytes: 20_000 })!.turns).toEqual({ total: 5, from: 3 });
    expect(host.snapshot(handle, { turns: 10, bytes: 40_000 })!.turns).toEqual({ total: 5, from: 1 });
    // Of the turn right before the cursor, too big alone, the page holds the last item: the answer, without its prompt.
    expect(host.snapshot(handle, { turns: 10, bytes: 20_000, beforeTurn: 3 })!.turns).toEqual({ total: 5, from: 2, offset: 1 });
    expect(host.snapshot(handle, { turns: 10, bytes: 20_000, beforeTurn: 2, offset: 1 })!.turns).toEqual({ total: 5, from: 1 });
    expect(host.snapshot(handle, { turns: 10, bytes: 20_000, beforeTurn: 1 })!.turns).toEqual({ total: 5, from: 0, offset: 1 });
    // A page's items carry the runs of their own calls, and no others.
    const page = host.snapshot(handle, { turns: 2, beforeTurn: 3 })!.state as unknown as SessionState;
    expect(page.items.flatMap((item) => (item.kind === "assistant" ? Object.entries(item.runs ?? {}).map(([id, run]) => [id, run.status]) : []))).toEqual([["t2", "done"], ["t3", "done"]]);
    expect("tools" in page).toBe(false);
  });

  it("pages a turn too big alone from its last items back, and the pages join into the whole chat", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { client: A });
    // Turn 0 is small; turn 1 is a long run: 12 answers of about 5 kB each.
    const answer = (n: number) => rec("message_end", { message: { role: "assistant", content: [{ type: "text", text: `${n}`.padEnd(5_000, ".") }], stopReason: "stop", timestamp: n } });
    fake.pis[0]!.handlers.onRecords([...assistantTurn(1), rec("agent_start"), userStart(2), ...Array.from({ length: 12 }, (_, n) => answer(n)), rec("agent_end"), rec("agent_settled")]);
    const items = host.stateOf(handle)!.items;
    const keys = (state: unknown) => ((state as SessionState).items as Item[]).map((item) => item.key);
    const first = host.snapshot(handle, { turns: 6, bytes: 16_000, outline: true })!;
    // Three answers fit; the prompt of the turn and the turn before are outlined.
    expect(first.turns).toEqual({ total: 2, from: 1, offset: 10 });
    expect(keys(first.state)).toEqual(items.slice(-3).map((item) => item.key));
    expect(first.outline!.map((turn) => turn.label)).toEqual(["q1", "q2"]);
    // Paging back from the cursor until the start gives every item once, in order.
    const pages = [keys(first.state)];
    let cursor = first.turns;
    while (cursor.from > 0 || cursor.offset) {
      const page = host.snapshot(handle, { turns: 20, beforeTurn: cursor.from, offset: cursor.offset, bytes: 16_000, outline: true })!;
      pages.unshift(keys(page.state));
      expect(page.outline).toHaveLength(page.turns.from + (page.turns.offset ? 1 : 0));
      cursor = page.turns;
    }
    expect(pages.flat()).toEqual(items.map((item) => item.key));
    expect(pages.map((page) => page.length)).toEqual([6, 3, 3, 3]); // turn 0 (2 items) joins the prompt and the first three answers
    // An answer bigger than a page comes alone; a cursor past the turn's end is its end.
    expect(host.snapshot(handle, { turns: 6, bytes: 1_000 })!.turns).toEqual({ total: 2, from: 1, offset: 12 });
    expect(keys(host.snapshot(handle, { turns: 6, beforeTurn: 1, offset: 99 })!.state)).toEqual(items.map((item) => item.key));
    expect(keys(host.snapshot(handle, { turns: 1, beforeTurn: 0, offset: 99 })!.state)).toEqual(items.slice(0, 2).map((item) => item.key));
  });

  it("gives clients the lean records and keeps no signatures in its state", async () => {
    const { host, seen } = await setup();
    const { handle } = await host.open(request, { client: A });
    const signed = { role: "assistant", content: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig".repeat(1000) }, { type: "text", text: "a" }], stopReason: "stop", timestamp: 1 };
    fake.pis[0]!.handlers.onRecords([rec("agent_start"), userStart(1), rec("message_end", { message: signed }), rec("turn_end", { message: signed, toolResults: [] }), rec("agent_end", { messages: [signed] }), rec("agent_settled")]);
    const sent = JSON.stringify(seen.filter((batch) => batch.handle === handle));
    expect(sent).not.toContain("thinkingSignature");
    expect(sent).toContain('{"type":"turn_end"}');
    expect(JSON.stringify(host.stateOf(handle))).not.toContain("thinkingSignature");
  });

  it("counts a big image as its URL in a phone's page, as the phone gets it", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { client: A });
    const shot = (n: number) => [
      rec("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: `s${n}`, name: "browser_screenshot", arguments: {} }], stopReason: "toolUse", timestamp: n } }),
      rec("tool_execution_end", { toolCallId: `s${n}`, toolName: "browser_screenshot", result: { content: [{ type: "image", mimeType: "image/png", data: "A".repeat(100_000) }] }, isError: false }),
    ];
    fake.pis[0]!.handlers.onRecords([rec("agent_start"), userStart(1), ...shot(1), ...shot(2), ...shot(3), rec("agent_end"), rec("agent_settled")]);
    expect(host.snapshot(handle, { turns: 6, bytes: 20_000 })!.turns).toEqual({ total: 1, from: 0, offset: 3 });
    expect(host.snapshot(handle, { turns: 6, bytes: 20_000, imagesByUrl: true })!.turns).toEqual({ total: 1, from: 0 });
  });

  it("never cuts a page before the first prompt: what comes before it comes along", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { client: A });
    const big = (text: string) => rec("message_end", { message: { role: "custom", customType: "note", content: text.padEnd(5_000, "."), display: true, timestamp: 1 } });
    const answer = (n: number) => rec("message_end", { message: { role: "assistant", content: [{ type: "text", text: `${n}`.padEnd(5_000, ".") }], stopReason: "stop", timestamp: n } });
    fake.pis[0]!.handlers.onRecords([big("before any prompt"), rec("agent_start"), userStart(1), answer(1), answer(2), rec("agent_end"), rec("agent_settled")]);
    const page = host.snapshot(handle, { turns: 6, bytes: 11_000, outline: true })!;
    expect(page.turns).toEqual({ total: 1, from: 0 });
    expect((page.state.items as Item[]).map((item) => item.kind)).toEqual(["custom", "user", "assistant", "assistant"]);
    expect(page.outline).toEqual([]);
  });

  it("outlines the turns before a page, one line each, and a paged join gets the live state", async () => {
    const { host } = await setup();
    const { handle } = await host.open(request, { client: A });
    const pi = fake.pis[0]!;
    const mentions = "look at this\n\n# Files mentioned by the user:\n\n## a.ts: /tmp/a.ts";
    pi.handlers.onRecords([rec("agent_start"), rec("message_end", { message: { role: "user", content: mentions, timestamp: 1 } }), rec("agent_end", { messages: [] }), rec("agent_settled")]);
    pi.handlers.onRecords([...assistantTurn(2), ...assistantTurn(3), ...assistantTurn(4)]);
    const keys = host.stateOf(handle)!.items.flatMap((item) => (item.kind === "user" ? [item.key] : []));
    const page = host.snapshot(handle, { turns: 1, outline: true })!;
    expect(page.turns).toEqual({ total: 4, from: 3 });
    // pi-gna's mention block is not part of the line.
    expect(page.outline).toEqual([
      { key: keys[0], at: 1, label: "look at this" },
      { key: keys[1], at: 2, label: "q2" },
      { key: keys[2], at: 3, label: "q3" },
    ]);
    expect(host.snapshot(handle, { turns: 2, beforeTurn: 3, outline: true })!.outline).toEqual([{ key: keys[0], at: 1, label: "look at this" }]);
    expect(host.snapshot(handle, { turns: 4, outline: true })!.outline).toEqual([]);
    expect(host.snapshot(handle, { turns: 1 })!.outline).toBeUndefined();

    const joined = await host.open(request, { client: B }, { turns: 2, outline: true });
    expect(joined.reused).toBe(true);
    expect(joined.snapshot!.turns).toEqual({ total: 4, from: 2 });
    expect(joined.snapshot!.outline!.map((turn) => turn.label)).toEqual(["look at this", "q2"]);
    expect((joined.snapshot!.state.items as Item[]).filter((item) => item.kind === "assistant")).toHaveLength(2);
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

  it("holds streaming deltas for a frame and sends them merged, ahead of any other event; a snapshot meanwhile is followed by them", async () => {
    vi.useFakeTimers();
    try {
      const { host, seen, globals } = await setup();
      const { handle } = await host.open({ cwd: "/tmp" }, { client: A });
      const pi = fake.pis[0]!;
      const delta = (text: string) => rec("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
      const text = () => (host.stateOf(handle)!.items.at(-1) as Extract<Item, { kind: "assistant" }>).message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      pi.handlers.onRecords([rec("agent_start"), rec("message_start", { message: { role: "assistant", content: [], stopReason: "stop", timestamp: 1 } }), rec("message_update", { assistantMessageEvent: { type: "text_start", contentIndex: 0 } })]);
      const batches = seen.length;
      const attention = globals.filter((e) => e.kind === "attention").length;

      pi.handlers.onRecords([delta("Hel")]);
      pi.handlers.onRecords([delta("lo")]);
      expect(seen).toHaveLength(batches);
      const snap = host.snapshot(handle, { turns: 1 })!;
      expect(snap.seq).toBe(seen.at(-1)!.seq);
      expect(text()).toBe("");
      vi.advanceTimersByTime(16);
      expect(seen.slice(batches).map((batch) => batch.events)).toEqual([[{ kind: "rpc", record: delta("Hello") }]]);
      expect(seen.at(-1)!.seq).toBeGreaterThan(snap.seq);
      expect(text()).toBe("Hello");

      pi.handlers.onRecords([delta(", ")]);
      pi.handlers.onRecords([delta("world"), rec("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello, world" } })]);
      expect(seen.slice(batches + 1).map((batch) => batch.events)).toEqual([[{ kind: "rpc", record: delta(", world") }, { kind: "rpc", record: rec("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello, world" } }) }]]);
      vi.advanceTimersByTime(100);
      expect(seen).toHaveLength(batches + 2);
      expect(globals.filter((e) => e.kind === "attention")).toHaveLength(attention);

      pi.handlers.onRecords([delta("!")]);
      await host.close(handle);
      expect(seen.slice(batches + 2).flatMap((batch) => batch.events.map((event) => event.kind))).toEqual(["rpc", "closed", "exit"]);
    } finally {
      vi.useRealTimers();
    }
  });

  let files = 0;
  /** A chat that was prompted, ran and was read, then left on no screen: idle from now. */
  async function idleChat(host: SessionHost, lease: { client?: { clientId: string; actor: string }; hold?: string } = { client: A }, extra: object = {}) {
    const { handle } = await host.open({ cwd: "/tmp", sessionPath: `/tmp/idle-${++files}.jsonl`, ...extra }, lease);
    await vi.waitFor(() => expect(host.stateOf(handle)!.phase).toBe("ready"));
    await host.command(handle, { type: "prompt", message: "hi" });
    const pi = fake.pis.at(-1)!;
    pi.handlers.onRecords(assistantTurn(1));
    if (lease.client) {
      host.viewing(handle, lease.client.clientId, true);
      host.viewing(handle, lease.client.clientId, false);
    }
    expect(host.stateOf(handle)).toMatchObject({ prompted: true, running: false, unread: undefined, dialogs: [] });
    return { handle, pi };
  }

  describe("idle chats stop their pi", () => {
    const MIN = 60_000;
    const closedBy = (seen: { handle: string; events: { kind: string; by?: unknown }[] }[], handle: string) =>
      seen.filter((batch) => batch.handle === handle).flatMap((batch) => batch.events).find((event) => event.kind === "closed")?.by;

    it("stops a prompted chat nobody shows after 30 idle minutes, and its file opens again", async () => {
      const { host, seen, globals } = await setup();
      const { handle, pi } = await idleChat(host);
      host.stopIdle(Date.now() + 29 * MIN);
      expect(pi.closed).toBe(false);
      host.stopIdle(Date.now() + 31 * MIN);
      expect(pi.closed).toBe(true);
      expect(closedBy(seen, handle)).toBe("host");
      expect(globals).toContainEqual({ kind: "chat.closed", handle });
      expect(host.stateOf(handle)).toBeUndefined();
      const again = await host.open({ cwd: "/tmp", sessionPath: pi.opts.sessionPath }, { client: A });
      expect(again.handle).not.toBe(handle);
      expect(again.reused).toBeUndefined();
      expect(fake.pis.at(-1)).not.toBe(pi);
    });

    it("counts idle time from the chat's last event", async () => {
      const { host } = await setup();
      const { pi } = await idleChat(host);
      const later = Date.now() + 20 * MIN;
      vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        pi.handlers.onRecords([rec("queue_update", { steering: [], followUp: [] })]);
      } finally {
        vi.restoreAllMocks();
      }
      host.stopIdle(later + 29 * MIN);
      expect(pi.closed).toBe(false);
      host.stopIdle(later + 31 * MIN);
      expect(pi.closed).toBe(true);
    });

    it("checks every minute on its own", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      try {
        const { host } = await setup();
        const { pi } = await idleChat(host);
        vi.advanceTimersByTime(29 * MIN);
        expect(pi.closed).toBe(false);
        vi.advanceTimersByTime(2 * MIN);
        expect(pi.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the 8 most recently active idle chats and stops the rest", async () => {
      const { host } = await setup();
      const start = Date.now();
      const chats = [];
      for (let i = 0; i < 10; i++) {
        vi.spyOn(Date, "now").mockReturnValue(start + i * 1000);
        try {
          chats.push(await idleChat(host));
        } finally {
          vi.restoreAllMocks();
        }
      }
      host.stopIdle(start + 20_000);
      expect(chats.map((chat) => chat.pi.closed)).toEqual([true, true, false, false, false, false, false, false, false, false]);
    });

    it("never stops a running chat", async () => {
      const { host } = await setup();
      const control = await idleChat(host);
      const { pi } = await idleChat(host);
      pi.handlers.onRecords([rec("agent_start")]);
      host.stopIdle(Date.now() + 10 * 60 * MIN);
      expect(control.pi.closed).toBe(true);
      expect(pi.closed).toBe(false);
    });

    it("never stops a chat waiting on the user", async () => {
      const { host } = await setup();
      const control = await idleChat(host);
      const { pi } = await idleChat(host);
      pi.handlers.onRecords([rec("extension_ui_request", { id: "c1", method: "confirm", title: "Run rm?" })]);
      host.stopIdle(Date.now() + 10 * 60 * MIN);
      expect(control.pi.closed).toBe(true);
      expect(pi.closed).toBe(false);
    });

    it("never stops an unread chat", async () => {
      const { host } = await setup();
      const control = await idleChat(host);
      const { handle, pi } = await idleChat(host);
      pi.handlers.onRecords(assistantTurn(2));
      expect(host.stateOf(handle)!.unread).toBe("done");
      host.stopIdle(Date.now() + 10 * 60 * MIN);
      expect(control.pi.closed).toBe(true);
      expect(pi.closed).toBe(false);
    });

    it("never stops a chat held host-side (an ATP worker's run, a card's task)", async () => {
      const { host } = await setup();
      const control = await idleChat(host);
      const { pi } = await idleChat(host, { client: A, hold: "atp:run" });
      host.stopIdle(Date.now() + 10 * 60 * MIN);
      expect(control.pi.closed).toBe(true);
      expect(pi.closed).toBe(false);
    });

    it("leaves ATP chats to their runner and page", async () => {
      const { host } = await setup({ ...base, atp: true });
      const control = await idleChat(host);
      const { pi } = await idleChat(host, { client: A }, { atp: { role: "orchestrator", plan: "/p/x.atp.json" } });
      host.stopIdle(Date.now() + 10 * 60 * MIN);
      expect(control.pi.closed).toBe(true);
      expect(pi.closed).toBe(false);
    });

    it("never stops a chat whose pi is still starting", async () => {
      const { host } = await setup();
      const control = await idleChat(host);
      const send = fake.send;
      fake.send = (command) => ((command as { type: string }).type === "get_state" ? new Promise(() => {}) : send(command, undefined));
      try {
        const { handle } = await host.open({ cwd: "/tmp", sessionPath: "/tmp/booting.jsonl" }, { client: A });
        expect(host.stateOf(handle)!.phase).toBe("starting");
        host.stopIdle(Date.now() + 10 * 60 * MIN);
        expect(control.pi.closed).toBe(true);
        expect(fake.pis.at(-1)!.closed).toBe(false);
      } finally {
        fake.send = send;
      }
    });

    it("never stops a chat a client shows, focused or not, nor one a phone is viewing", async () => {
      const { host } = await setup();
      const control = await idleChat(host);
      const shown = await idleChat(host);
      host.shown(shown.handle, "a", true);
      const viewed = await idleChat(host, { client: B });
      host.viewing(viewed.handle, "b", true);
      host.stopIdle(Date.now() + 10 * 60 * MIN);
      expect(control.pi.closed).toBe(true);
      expect(shown.pi.closed).toBe(false);
      expect(viewed.pi.closed).toBe(false);
      // Idle from when it left the screen.
      const left = Date.now() + 20 * MIN;
      vi.spyOn(Date, "now").mockReturnValue(left);
      try {
        host.shown(shown.handle, "a", false);
      } finally {
        vi.restoreAllMocks();
      }
      host.stopIdle(left + 29 * MIN);
      expect(shown.pi.closed).toBe(false);
      host.stopIdle(left + 31 * MIN);
      expect(shown.pi.closed).toBe(true);
    });
  });

  describe("a spare pi for the next New chat", () => {
    const MIN = 60_000;
    const hosts: SessionHost[] = [];
    beforeEach(() => {
      machine.load = 0;
      machine.inputs = "inputs-1";
    });
    afterEach(async () => {
      machine.load = Number.POSITIVE_INFINITY;
      for (const host of hosts.splice(0)) await host.closeAll();
    });
    /** A host whose features can change between spawning the spare and opening the chat. */
    async function spareHost(features: () => SessionFeatures = () => base) {
      fake.pis.length = 0;
      const host = new SessionHost(() => 0, bridge as unknown as AgentBridge, "/atp", async () => features());
      hosts.push(host);
      return { host };
    }
    const status = (text: string) => rec("extension_ui_request", { id: `s-${text}`, method: "setStatus", statusKey: "boot", statusText: text });

    it("is taken by a New chat in its folder: no second pi, its tools act for the chat, what it said comes along", async () => {
      const { host } = await spareHost();
      await host.spawnSpare("/tmp");
      expect(fake.pis).toHaveLength(1);
      const spare = fake.pis[0]!;
      expect(spare.opts.sessionPath).toBeUndefined();
      const spareHandle = bridge.register.mock.lastCall![0];
      spare.handlers.onRecords([status("booted")]);
      const { handle } = await host.open({ cwd: "/tmp", handle: "newchat1" }, { client: A });
      expect(handle).toBe("newchat1");
      expect(fake.pis).toHaveLength(1);
      expect(bridge.rename).toHaveBeenLastCalledWith(spareHandle, "newchat1");
      await vi.waitFor(() => expect(host.stateOf(handle)!.phase).toBe("ready"));
      expect(host.stateOf(handle)!.statuses).toEqual({ boot: "booted" });
      spare.handlers.onRecords(assistantTurn(1));
      expect(host.stateOf(handle)!.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
      await host.close(handle);
      expect(spare.closed).toBe(true);
      expect(host.stateOf(handle)).toBeUndefined();
    });

    it("waits for the bridge before it spawns, so pi gets the bridge's URL", async () => {
      let listen!: () => void;
      const listening = new Promise<void>((resolve) => (listen = () => resolve(void (late.url = "http://127.0.0.1:4242"))));
      const late = { ...bridge, url: "", start: () => listening };
      fake.pis.length = 0;
      const host = new SessionHost(() => 0, late as unknown as AgentBridge, "/atp", async () => base);
      hosts.push(host);
      const spare = host.spawnSpare("/tmp");
      const opened = host.open({ cwd: "/tmp", sessionPath: "/tmp/s1.jsonl" }, { client: A });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.pis).toHaveLength(0);
      listen();
      await Promise.all([spare, opened]);
      expect(fake.pis).toHaveLength(2);
      for (const pi of fake.pis) expect((pi.opts as { env?: Record<string, string> }).env?.PIGNA_BRIDGE).toBe("http://127.0.0.1:4242");
    });

    it("is not taken by a session file, an ATP chat or a chat in another folder", async () => {
      const { host } = await spareHost(() => ({ ...base, atp: true }));
      await host.spawnSpare("/tmp");
      await host.open({ cwd: "/tmp", sessionPath: "/tmp/s1.jsonl" }, { client: A });
      await host.open({ cwd: "/tmp", atp: { role: "orchestrator" } }, { client: A });
      await host.open({ cwd: "/" }, { client: A });
      expect(fake.pis).toHaveLength(4);
      expect(fake.pis[0]!.closed).toBe(false);
      await host.open({ cwd: "/tmp" }, { client: A });
      expect(fake.pis).toHaveLength(4);
    });

    it("stops instead of being taken when it is stale: other features, or pi's files changed since", async () => {
      let features = base;
      const { host } = await spareHost(() => features);
      await host.spawnSpare("/tmp");
      features = { ...base, kanban: true };
      await host.open({ cwd: "/tmp" }, { client: A });
      expect(fake.pis).toHaveLength(2);
      expect(fake.pis[0]!.closed).toBe(true);
      await host.spawnSpare("/tmp");
      expect(fake.pis).toHaveLength(3);
      machine.inputs = "inputs-2";
      await host.open({ cwd: "/tmp" }, { client: A });
      expect(fake.pis).toHaveLength(4);
      expect(fake.pis[2]!.closed).toBe(true);
    });

    it("is one at most, for the folder opened last, kept while current, and not started on a busy machine", async () => {
      const { host } = await spareHost();
      machine.load = 8;
      await host.spawnSpare("/tmp");
      expect(fake.pis).toHaveLength(0);
      machine.load = 7.9;
      await host.spawnSpare("/tmp");
      await host.spawnSpare("/tmp");
      expect(fake.pis).toHaveLength(1);
      await host.spawnSpare("/");
      expect(fake.pis).toHaveLength(2);
      expect(fake.pis[0]!.closed).toBe(true);
      await Promise.all([host.spawnSpare("/tmp"), host.spawnSpare("/tmp")]);
      expect(fake.pis).toHaveLength(3);
      expect(fake.pis[1]!.closed).toBe(true);
      // A settings change while a spawn reads pi's files cancels it.
      await host.retireSpare("settings changed");
      const spawning = host.spawnSpare("/tmp");
      void host.retireSpare("settings changed");
      await spawning;
      expect(fake.pis).toHaveLength(3);
      await host.spawnSpare("/tmp");
      machine.load = 8;
      host.stopIdle();
      expect(fake.pis[3]!.closed).toBe(true);
    });

    it("counts as an idle chat: it goes first past the cap, and is not started when the idle chats fill it", async () => {
      const { host } = await spareHost();
      const chats = [];
      for (let i = 0; i < 7; i++) chats.push(await idleChat(host));
      await host.spawnSpare("/tmp");
      const spare = fake.pis.at(-1)!;
      host.stopIdle();
      expect(spare.closed).toBe(false);
      chats.push(await idleChat(host));
      host.stopIdle();
      expect(spare.closed).toBe(true);
      expect(chats.some((chat) => chat.pi.closed)).toBe(false);
      const count = fake.pis.length;
      await host.spawnSpare("/tmp");
      expect(fake.pis).toHaveLength(count);
    });

    it("goes when unused for 10 minutes, when its pi exits, on a settings change and at quit", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      try {
        const { host } = await spareHost();
        await host.spawnSpare("/tmp");
        vi.advanceTimersByTime(9 * MIN);
        expect(fake.pis[0]!.closed).toBe(false);
        vi.advanceTimersByTime(MIN);
        expect(fake.pis[0]!.closed).toBe(true);
        await host.spawnSpare("/tmp");
        fake.pis[1]!.handlers.onExit({ code: 1, signal: null, stderrTail: "" });
        await host.spawnSpare("/tmp");
        expect(fake.pis).toHaveLength(3);
        await host.retireSpare("settings changed");
        expect(fake.pis[2]!.closed).toBe(true);
        await host.spawnSpare("/tmp");
        await host.closeAll();
        expect(fake.pis[3]!.closed).toBe(true);
        await host.spawnSpare("/tmp");
        expect(fake.pis).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts 2 s after a chat a client opened is ready, not after a host-held or ATP chat", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { host } = await spareHost(() => ({ ...base, atp: true }));
        await host.open({ cwd: "/tmp", sessionPath: "/tmp/task.jsonl" }, { hold: "task:1" });
        await host.open({ cwd: "/tmp", atp: { role: "orchestrator" } }, { client: A });
        await vi.advanceTimersByTimeAsync(5000);
        expect(fake.pis).toHaveLength(2);
        await host.open({ cwd: "/tmp", sessionPath: "/tmp/s2.jsonl" }, { client: A });
        await vi.advanceTimersByTimeAsync(1900);
        expect(fake.pis).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(200);
        expect(fake.pis).toHaveLength(4);
        expect(fake.pis[3]!.opts.sessionPath).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── Command semantics ────────────────────────────────────────────────────────

describe("command semantics", () => {
  const request = { cwd: "/tmp", sessionPath: "/tmp/c.jsonl" };
  const phone = { caller: { device: "dev1" }, clientId: "p", bootId: "b" } as const;
  const rec = (type: string, extra: object = {}) => ({ type, ...extra });

  async function setup() {
    const { SessionHost: Host } = await import("./session-host");
    fake.pis.length = 0;
    fake.responded.length = 0;
    fake.send = async () => undefined;
    const events: { kind: string; [key: string]: unknown }[] = [];
    const yolo = { on: false };
    const host = new Host((batch) => void events.push(...(batch.events as never[])), bridge as unknown as AgentBridge, "/atp", undefined, () => yolo.on);
    const { handle } = await host.open(request);
    return { host, handle, events, pi: fake.pis[0]!, yolo };
  }

  it("with yolo on, allows approvals without a card and leaves the rest to the user", async () => {
    const { host, handle, events, pi, yolo } = await setup();
    yolo.on = true;
    pi.handlers.onRecords([
      { type: "extension_ui_request", id: "c1", method: "confirm", title: "Run rm?" },
      { type: "extension_ui_request", id: "s1", method: "select", title: "pi wants to browse https://example.com", options: ["Allow example.com for this session", "Deny"] },
      { type: "extension_ui_request", id: "s2", method: "select", title: "Pick a color", options: ["red", "green"] },
      { type: "extension_ui_request", id: "i1", method: "input", title: "Name" },
    ]);
    expect(fake.responded).toEqual([
      { type: "extension_ui_response", id: "c1", confirmed: true },
      { type: "extension_ui_response", id: "s1", value: "Allow example.com for this session" },
    ]);
    expect(host.stateOf(handle)!.dialogs.map((dialog) => dialog.id)).toEqual(["s2", "i1"]);
    // Computer Use's own card: a one-time grant, never "Always allow", and nothing shown.
    const before = events.length;
    await expect(host.requestChoice(handle, "pi wants to use Calculator", ["Allow once", "Always allow", "Deny"])).resolves.toBe("Allow once");
    expect(events.length).toBe(before);

    // Read at each approval: off again, the user is asked.
    yolo.on = false;
    pi.handlers.onRecords([{ type: "extension_ui_request", id: "c2", method: "confirm", title: "Run rm?" }]);
    expect(fake.responded).toHaveLength(2);
    expect(host.stateOf(handle)!.dialogs.map((dialog) => dialog.id)).toContain("c2");
  });

  it("refuses commands outside the allowlist for remote callers, not the desktop", async () => {
    const { host, handle } = await setup();
    await expect(host.command(handle, { type: "bash", command: "ls" } as never, phone)).rejects.toMatchObject({ code: "scope_denied" });
    await expect(host.command(handle, { type: "new_session" } as never, phone)).rejects.toMatchObject({ code: "scope_denied" });
    expect((await host.command(handle, { type: "get_state" }, phone)).success).toBe(true);
    expect((await host.command(handle, { type: "bash", command: "ls" } as never)).success).toBe(true);
  });

  it("keeps the snapshot's model current after set_model, for clients that join later", async () => {
    const { host, handle } = await setup();
    const sonnet = { provider: "anthropic", id: "sonnet", name: "Sonnet" };
    fake.send = async (command) => ((command as { type: string }).type === "get_state" ? { type: "response", success: true, data: { model: sonnet, thinkingLevel: "high" } } : undefined);
    await host.command(handle, { type: "set_model", provider: "anthropic", modelId: "sonnet" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.snapshot(handle, { turns: 10 })?.state.model).toEqual(sonnet);
  });

  it("makes interrupt and editQueue atomic under concurrent calls", async () => {
    const { host, handle, pi } = await setup();
    pi.handlers.onRecords([rec("agent_start")]);
    const log: string[] = [];
    fake.send = async (command) => {
      const { type, message } = command as { type: string; message?: string };
      log.push(`${type}${message ? `:${message}` : ""}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`${type}${message ? `:${message}` : ""}:end`);
      return type === "clear_queue" ? { type: "response", success: true, data: { steering: ["a", "b"], followUp: ["c"] } } : undefined;
    };
    const [edited, restored, sent] = await Promise.all([
      host.editQueue(handle, { type: "remove", kind: "steering", text: "a" }),
      host.interrupt(handle),
      host.command(handle, { type: "steer", message: "late" }),
    ]);
    expect(edited).toBe(true);
    expect(restored).toEqual(["a", "b", "c"]);
    expect(sent.success).toBe(true);
    // Each call's commands are contiguous: the next one starts only after the previous one's last command ended.
    expect(log.filter((entry) => entry.endsWith(":start")).map((entry) => entry.replace(":start", ""))).toEqual([
      "clear_queue", "steer:b", "follow_up:c", "clear_queue", "abort", "steer:late",
    ]);
    const ends = log.map((entry, index) => (entry.endsWith(":end") ? index : -1)).filter((index) => index >= 0);
    for (const [i, entry] of log.entries()) if (entry.endsWith(":start") && i > 0) expect(log[i - 1]!.endsWith(":end")).toBe(true);
    expect(ends).toHaveLength(6);
  });

  it("lets the first answer to a dialog win and tells everyone", async () => {
    const { host, handle, events, pi } = await setup();
    pi.handlers.onRecords([{ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run?" }]);
    expect(host.snapshot(handle, { turns: 5 })!.state.dialogs).toHaveLength(1);
    host.respondDialog(handle, { type: "extension_ui_response", id: "d1", confirmed: true }, phone);
    expect(events.filter((e) => e.kind === "dialog_resolved")).toEqual([{ kind: "dialog_resolved", id: "d1", by: { device: "dev1" }, outcome: "answered" }]);
    expect(host.snapshot(handle, { turns: 5 })!.state.dialogs).toHaveLength(0);
    expect(() => host.respondDialog(handle, { type: "extension_ui_response", id: "d1", confirmed: false })).toThrowError(expect.objectContaining({ code: "already_answered" }));
    expect(() => host.respondDialog(handle, { type: "extension_ui_response", id: "nope", confirmed: false })).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(fake.responded).toHaveLength(1);
  });

  it("answers main's own choices once, and settles dialogs on pi timeout and exit", async () => {
    vi.useFakeTimers();
    try {
      const { host, handle, events, pi } = await setup();
      const choice = host.requestChoice(handle, "Allow?", ["Allow", "Deny"]);
      const id = (events.find((e) => (e.record as { id?: string } | undefined)?.id?.startsWith("pigna-choice-"))!.record as { id: string }).id;
      host.respondDialog(handle, { type: "extension_ui_response", id, value: "Allow" }, phone);
      await expect(choice).resolves.toBe("Allow");
      expect(() => host.respondDialog(handle, { type: "extension_ui_response", id, value: "Deny" })).toThrowError(expect.objectContaining({ code: "already_answered" }));
      expect(fake.responded).toHaveLength(0);

      pi.handlers.onRecords([{ type: "extension_ui_request", id: "t1", method: "input", title: "Name", timeout: 1000 }]);
      vi.advanceTimersByTime(1000);
      expect(events.at(-1)).toMatchObject({ kind: "dialog_resolved", id: "t1", outcome: "timeout" });
      expect(() => host.respondDialog(handle, { type: "extension_ui_response", id: "t1", value: "x" })).toThrowError(expect.objectContaining({ code: "already_answered" }));

      pi.handlers.onRecords([{ type: "extension_ui_request", id: "e1", method: "select", title: "Pick", options: ["a"] }]);
      await pi.close();
      expect(events.filter((e) => e.kind === "dialog_resolved" && e.id === "e1")).toMatchObject([{ outcome: "exit" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
