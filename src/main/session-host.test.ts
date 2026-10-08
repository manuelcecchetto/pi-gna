import { describe, expect, it, vi } from "vitest";

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
        const [a, b] = await Promise.all([first, second]);
        expect(b).toEqual({ handle: a.handle, reused: true });
        expect(a).toEqual({ handle: a.handle });
        expect(read.reads).toBe(1);
        expect(fake.pis).toHaveLength(1);
        expect(host.stateOf(a.handle)!.items.map((item) => item.kind)).toEqual(["user"]);
        expect(host.stateOf(a.handle)!.phase).toBe("ready");
        expect(host.presence(a.handle).map((c) => c.clientId)).toEqual(["a", "b"]);
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
    // The turn right before the cursor comes even when it alone is too big.
    expect(host.snapshot(handle, { turns: 10, bytes: 20_000, beforeTurn: 3 })!.turns).toEqual({ total: 5, from: 2 });
    expect(host.snapshot(handle, { turns: 10, bytes: 20_000, beforeTurn: 1 })!.turns).toEqual({ total: 5, from: 0 });
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
    const host = new Host((batch) => void events.push(...(batch.events as never[])), bridge, "/atp", undefined, () => yolo.on);
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
