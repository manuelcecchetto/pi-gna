import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostError } from "../../shared/host-api";
import { createSession } from "../../shared/session-state";
import { HostClient, type Env, type EventSourceLike } from "./host-client";

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 1;
  onopen = null;
  onerror: ((e: unknown) => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) });
  }
  hello(bootId = "b1", seq = 0) {
    this.emit("hello", { bootId, seq, buildId: "x" });
  }
  host(seq: number, topic: string, event: unknown, bootId = "b1") {
    this.emit("host", { bootId, seq, topic, event });
  }
}

interface Call {
  path: string;
  headers: Record<string, string>;
  body: any;
}

const settings = { rev: 1, theme: "dark" };
const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });
const fail = (status: number, code: string, detail?: object) => new Response(JSON.stringify({ error: { code, message: code, detail } }), { status });

function setup(handler: (call: Call, n: number) => Response | Promise<Response>) {
  FakeSource.all = [];
  const calls: Call[] = [];
  let wake = () => {};
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let ids = 0;
  const env: Env = {
    fetch: (async (input: string, init?: RequestInit) => {
      const call: Call = { path: String(input).replace(/^\/api\/(call\/)?/, ""), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return handler(call, calls.length);
    }) as typeof fetch,
    EventSource: FakeSource,
    setTimeout: (fn, ms) => {
      const id = ++ids;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    sleep: async () => {},
    uuid: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
    onWake: (w) => {
      wake = w;
      return () => {};
    },
  };
  const unauthorized = vi.fn();
  const outdated = vi.fn();
  const client = new HostClient({ env, buildId: "x", onUnauthorized: unauthorized, onOutdated: outdated });
  return { client, calls, timers, wake: () => wake(), unauthorized, outdated, src: () => FakeSource.all.at(-1)! };
}

/** Answers the snapshot reads the client makes on resync. */
function reads() {
  return (call: Call): Response => {
    if (call.path === "chat.list") return ok([]);
    if (call.path === "chat.live") return ok([{ handle: "live1", cwd: "/p", title: "Live", attention: "running", running: true, dialogs: 0 }]);
    if (call.path === "settings.get") return ok({ seq: 5, value: settings });
    if (call.path.endsWith(".get") || call.path === "atp.state" || call.path === "browser.state") return ok({ seq: 5, value: { rev: 1 } });
    if (call.path === "chat.snapshot") return ok({ seq: 10, value: { state: createSession(call.body.handle, "/p"), turns: { total: 0, from: 0 } } });
    return ok(null);
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

describe("calls", () => {
  it("sends the client header, boot id and a key only for mutating methods", async () => {
    const { client, calls } = setup(() => ok({ done: true }));
    await client.call("board.get", {});
    await client.call("chat.close", { handle: "abc123" });
    expect(calls[0]!.headers["x-pigna-client"]).toBe("1");
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[1]!.headers["idempotency-key"]).toMatch(/^uuid-/);
  });

  it("retries a keyed call with the same key, and surfaces JSON errors", async () => {
    const { client, calls } = setup((_, n) => (n < 3 ? fail(503, "unavailable") : ok({ ok: true })));
    await expect(client.call("chat.close", { handle: "abc123" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);

    const bad = setup(() => fail(409, "conflict", { rev: 4 }));
    const error = await bad.client.call("settings.apply", { op: {} as never }).catch((e) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error.code).toBe("conflict");
    expect(error.detail).toEqual({ rev: 4 });
    expect(bad.calls).toHaveLength(1);
  });

  it("retries network failures and never retries host_restarted", async () => {
    let n = 0;
    const net = setup(() => {
      if (++n < 2) throw new TypeError("network");
      return ok({ ok: true });
    });
    await expect(net.client.call("chat.close", { handle: "abc123" })).resolves.toEqual({ ok: true });

    const restarted = setup(() => fail(409, "host_restarted"));
    await expect(restarted.client.call("chat.close", { handle: "abc123" })).rejects.toMatchObject({ code: "host_restarted" });
    expect(restarted.calls).toHaveLength(1);
  });

  it("names its stream on calls and hands its own login progress to listeners", async () => {
    const t = setup(() => ok({}));
    await t.client.call("providers.cancel", {});
    expect(t.calls.at(-1)!.headers["x-pigna-stream"]).toBe(t.client.streamId);
    const seen: unknown[] = [];
    t.client.onLoginUpdate((update) => seen.push(update));
    t.client.start();
    t.src().hello();
    const update = { kind: "event", event: { type: "device_code", userCode: "AB-12", verificationUri: "https://x.test" } };
    t.src().emit("client", { kind: "providers.login", update });
    expect(seen).toEqual([update]);
  });

  it("goes to unauthorized on a 401", async () => {
    const t = setup(() => fail(401, "unauthorized"));
    await expect(t.client.call("board.get", {})).rejects.toMatchObject({ code: "unauthorized" });
    expect(t.client.store.get().connection).toBe("unauthorized");
    expect(t.unauthorized).toHaveBeenCalled();
  });
});

describe("stream", () => {
  it("takes a snapshot method's bare answer as the value (the host does not stamp a seq)", async () => {
    const t = setup((call) => (call.path === "ui.get" ? ok({ rev: 2, pins: ["/p"], hidden: [], bookmarks: {} }) : reads()(call)));
    t.client.start();
    t.src().hello();
    await flush();
    t.src().emit("resync", { reason: "no_id" });
    await flush();
    expect(t.client.store.get().global.ui).toEqual({ rev: 2, pins: ["/p"], hidden: [], bookmarks: {} });
  });

  it("goes live on hello, loads snapshots and applies only newer global events", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    t.src().emit("resync", { reason: "no_id" });
    await flush();
    expect(t.client.store.get().connection).toBe("live");
    expect(t.client.store.get().global.settings).toEqual(settings);
    t.src().host(6, "global", { kind: "settings", settings: { rev: 2, theme: "light" } });
    t.src().host(6, "global", { kind: "settings", settings: { rev: 3, theme: "dup" } });
    expect(t.client.store.get().global.settings).toEqual({ rev: 2, theme: "light" });
  });

  it("buffers events that race the snapshot and drops those it already reflects", async () => {
    const t = setup(reads());
    t.client.start();
    const src = t.src();
    src.emit("resync", { reason: "no_id" });
    src.host(4, "global", { kind: "settings", settings: { rev: 0, theme: "old" } });
    src.host(7, "global", { kind: "settings", settings: { rev: 9, theme: "new" } });
    await flush();
    expect(t.client.store.get().global.settings).toEqual({ rev: 9, theme: "new" });
  });

  it("reduces chat events after the chat snapshot and ignores seq <= snapshot seq", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    await t.client.setChats(["abc123"]);
    await flush();
    expect(t.calls.find((c) => c.path === "subscribe")!.body).toEqual({ stream: t.client.streamId, chats: ["abc123"] });
    expect(t.client.store.get().chats.abc123!.seq).toBe(10);
    const ready = { kind: "ready", state: { isStreaming: false, sessionId: "s1", sessionName: "named" } };
    t.src().host(9, "chat:abc123", ready);
    expect(t.client.store.get().chats.abc123!.session!.sessionId).toBeUndefined();
    t.src().host(11, "chat:abc123", ready);
    expect(t.client.store.get().chats.abc123!.session!.sessionId).toBe("s1");
    expect(t.client.store.get().chats.abc123!.seq).toBe(11);
  });

  it("reads the live chats' attention on resync and keeps applying deltas", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    t.src().emit("resync", { reason: "no_id" });
    await flush();
    expect(Object.keys(t.client.store.get().global.attention)).toEqual(["live1"]);
    t.src().host(1, "global", { kind: "attention", chats: [{ handle: "live1", title: "Live", attention: "waiting" }], removed: [] });
    expect(t.client.store.get().global.attention.live1!.attention).toBe("waiting");
  });

  it("prepends the page before the snapshot's first turn and ignores a stale page", async () => {
    const item = (text: string) => ({ kind: "user", message: { role: "user", content: text, timestamp: 1 } });
    const page = (items: unknown[], from: number) => ({ seq: 10, value: { state: { ...createSession("abc123", "/p"), items, tools: {} }, turns: { total: 4, from } } });
    let served = 0;
    const t = setup((call) => {
      if (call.path !== "chat.snapshot") return reads()(call);
      served++;
      return ok(call.body.before === undefined ? page([item("c"), item("d")], 2) : page([item("a"), item("b")], 0));
    });
    t.client.start();
    t.src().hello();
    await flush();
    await t.client.setChats(["abc123"]);
    await flush();
    expect(t.client.store.get().chats.abc123!.turns).toEqual({ total: 4, from: 2 });
    await t.client.loadEarlier("abc123");
    await flush();
    const entry = t.client.store.get().chats.abc123!;
    expect(entry.session!.items.map((i) => (i as any).message.content)).toEqual(["a", "b", "c", "d"]);
    expect(entry.turns).toEqual({ total: 4, from: 0 });
    expect(t.calls.filter((c) => c.path === "chat.snapshot").at(-1)!.body).toEqual({ handle: "abc123", before: 2, turns: 20 });
    await t.client.loadEarlier("abc123"); // nothing before turn 0: no call
    expect(served).toBe(2);
  });

  it("subscribes again and rereads the chats when the browser's own retry brings the stream back", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    await t.client.setChats(["abc123"]);
    await flush();
    const before = t.calls.filter((c) => c.path === "subscribe").length;
    // The same EventSource reconnected by itself: same URL (without the chat), same boot, a new hello.
    t.src().hello();
    await flush();
    expect(t.calls.filter((c) => c.path === "subscribe")).toHaveLength(before + 1);
    expect(t.calls.filter((c) => c.path === "chat.snapshot")).toHaveLength(2);
    expect(t.calls.filter((c) => c.path === "subscribe").at(-1)!.body.chats).toEqual(["abc123"]);
  });

  it("carries the chats on screen in the URL when it reconnects", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    await t.client.setChats(["abc123", "def456"]);
    t.wake();
    expect(t.src().url).toContain("chats=abc123%2Cdef456");
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[0]!.readyState).toBe(2);
  });

  it("resyncs on a boot id change, restarting seq counting", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello("b1");
    await flush();
    t.src().host(20, "global", { kind: "settings", settings: { rev: 2, theme: "a" } });
    expect(t.client.store.get().lastSeq).toBe(20);
    t.src().host(1, "global", { kind: "settings", settings: { rev: 1, theme: "fresh" } }, "b2");
    await flush();
    expect(t.client.store.get().bootId).toBe("b2");
    expect(t.client.store.get().global.settings).toEqual(settings);
    t.src().host(6, "global", { kind: "settings", settings: { rev: 7, theme: "b2" } }, "b2");
    expect(t.client.store.get().global.settings).toEqual({ rev: 7, theme: "b2" });
  });

  it("replays a gap in order across a reconnect without duplicating", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    t.src().host(6, "global", { kind: "attention", chats: [{ handle: "a", title: "A" }], removed: [] });
    t.wake();
    const second = t.src();
    second.hello("b1", 8);
    await flush();
    second.host(6, "global", { kind: "attention", chats: [{ handle: "a", title: "dup" }], removed: [] });
    second.host(7, "global", { kind: "attention", chats: [{ handle: "b", title: "B" }], removed: [] });
    second.host(8, "global", { kind: "attention", chats: [], removed: ["a"] });
    expect(Object.keys(t.client.store.get().global.attention)).toEqual(["b"]);
    expect(t.client.store.get().lastSeq).toBe(8);
  });

  it("reconnects when the heartbeat watchdog fires, and shows unreachable after repeated failures", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    t.timers.find((x) => x.ms === 35_000)!.fn();
    expect(FakeSource.all).toHaveLength(2);
    expect(t.client.store.get().connection).toBe("reconnecting");
    for (let i = 0; i < 2; i++) t.timers.find((x) => x.ms === 35_000)!.fn();
    expect(t.client.store.get().connection).toBe("unreachable");
  });

  it("keeps the last state while unreachable", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    t.src().emit("resync", { reason: "no_id" });
    await flush();
    for (let i = 0; i < 3; i++) {
      t.src().readyState = 2;
      t.src().onerror?.({});
      t.timers.filter((x) => x.ms !== 35_000).at(-1)?.fn(); // the scheduled reconnect
    }
    expect(t.client.store.get().connection).toBe("unreachable");
    expect(t.client.store.get().global.settings).toEqual(settings);
  });

  it("detects an unauthenticated device and an outdated build via hello", async () => {
    const a = setup((call) => (call.path === "hello" ? ok({ buildId: "x", authenticated: false }) : ok(null)));
    a.client.start();
    a.src().readyState = 2;
    a.src().onerror?.({});
    await flush();
    expect(a.client.store.get().connection).toBe("unauthorized");
    expect(a.unauthorized).toHaveBeenCalled();

    const b = setup(reads());
    b.client.start();
    b.src().emit("hello", { bootId: "b1", seq: 0, buildId: "new" });
    await flush();
    expect(b.client.store.get().connection).toBe("outdated");
    expect(b.outdated).toHaveBeenCalled();
  });

  it("goes to unauthorized when the device is revoked while reconnecting, and stops retrying", async () => {
    const t = setup((call) => (call.path === "hello" ? ok({ buildId: "x", authenticated: false }) : reads()(call)));
    t.client.start();
    t.src().hello();
    await flush();
    t.src().emit("resync", { reason: "no_id" });
    await flush();
    expect(t.client.store.get().connection).toBe("live");
    t.src().readyState = 2;
    t.src().onerror?.({}); // the host closed the stream of the revoked device
    await flush();
    expect(t.client.store.get().connection).toBe("unauthorized");
    expect(t.unauthorized).toHaveBeenCalledTimes(1);
    const streams = FakeSource.all.length;
    for (const timer of t.timers) timer.fn();
    expect(FakeSource.all).toHaveLength(streams);
    expect(t.client.store.get().global.settings).toEqual(settings); // the last state stays for the sign-in screen
  });

  it("recovers on its own once the host answers again, with the state it had", async () => {
    const t = setup(reads());
    t.client.start();
    t.src().hello();
    await flush();
    for (let i = 0; i < 3; i++) {
      t.src().readyState = 2;
      t.src().onerror?.({});
      t.timers.filter((x) => x.ms !== 35_000).at(-1)?.fn();
    }
    expect(t.client.store.get().connection).toBe("unreachable");
    t.src().hello(); // the resumed host
    await flush();
    expect(t.client.store.get().connection).toBe("live");
  });
});


describe("theme synchronization", () => {
  it("reads themes on sync and applies only fresh live theme events", async () => {
    const themes = { version: 1, rev: 1, global: {}, projects: { "/p": { base: "dark" } } };
    const t = setup((call) => call.path === "themes.get" ? ok({ seq: 5, value: themes }) : reads()(call));
    t.client.start();
    t.src().hello();
    await flush();
    t.src().emit("resync", { reason: "no_id" });
    await flush();
    expect(t.client.store.get().global.themes).toEqual(themes);
    const next = { ...themes, rev: 2, projects: { "/p": { base: "light" } } };
    t.src().host(6, "global", { kind: "themes", themes: next });
    t.src().host(6, "global", { kind: "themes", themes });
    expect(t.client.store.get().global.themes).toEqual(next);
    t.client.stop();
  });
});
