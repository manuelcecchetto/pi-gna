import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", getPath: () => "/tmp" }, shell: {}, dialog: {} }));

import { HostError, methodScope, type HostMethod } from "../shared/host-api";
import { IdempotencyCache } from "./command-layer";
import { DeviceStore } from "./devices";
import { EventHub } from "./event-hub";
import { RemoteServer, type RemoteServerOptions } from "./remote-server";

const HOST = "mac.tail.ts.net";
const LOGIN = "me@example.com";

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  text: string;
  json: any;
}

let port = 0;
const send = (method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string>; host?: string; csrf?: boolean; login?: string | null } = {}) =>
  new Promise<Reply>((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? HOST, ...opts.headers };
    if (opts.login !== null) headers["tailscale-user-login"] = opts.login ?? LOGIN;
    if (opts.cookie) headers.cookie = opts.cookie;
    if (method === "POST" && opts.csrf !== false) Object.assign(headers, { origin: `https://${opts.host ?? HOST}`, "x-pigna-client": "1" });
    const text = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (text !== undefined) headers["content-type"] = "application/json";
    const req = httpRequest({ port, host: "127.0.0.1", method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        let json: any;
        try {
          json = JSON.parse(body);
        } catch {
          // not json
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: body, json });
      });
    });
    // A 413 can hang up while the big body is still being written; the reply is then lost (status 0).
    req.on("error", (error: NodeJS.ErrnoException) => (error.code === "EPIPE" || error.code === "ECONNRESET" ? resolve({ status: 0, headers: {}, text: "", json: undefined }) : reject(error)));
    req.end(text);
  });

/** An SSE connection that collects frames. */
function sse(path: string, cookie: string, headers: Record<string, string> = {}) {
  const frames: string[] = [];
  let raw = "";
  let res!: IncomingMessage;
  let ended = false;
  const ready = new Promise<void>((resolve, reject) => {
    const req = httpRequest({ port, host: "127.0.0.1", path, headers: { host: HOST, cookie, "tailscale-user-login": LOGIN, ...headers } }, (r) => {
      res = r;
      r.setEncoding("utf8");
      r.on("data", (chunk: string) => {
        raw += chunk;
        let at: number;
        while ((at = raw.indexOf("\n\n")) >= 0) {
          frames.push(raw.slice(0, at));
          raw = raw.slice(at + 2);
        }
      });
      r.on("end", () => (ended = true));
      resolve();
    });
    req.on("error", reject);
    req.end();
  });
  return {
    ready,
    frames,
    get ended() {
      return ended;
    },
    get res() {
      return res;
    },
    close: () => res?.destroy(),
    until: async (test: () => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (!test()) {
        if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

let dir: string;
let devices: DeviceStore;
let hub: EventHub;
let server: RemoteServer;
let calls: Array<{ method: string; args: unknown; client: unknown; clientId: string }>;
let log: string[];
let cookie: string;
let deviceId: string;
let boot = "boot1";

const names = new Set<string>(["board.get", "board.apply", "chat.command", "chat.list", "atp.state", "fs.pickFolder"]);

async function pairDevice(): Promise<{ cookie: string; id: string }> {
  devices.startPairing();
  const code = devices.pairingStatus().code!;
  const claimed = await send("POST", "/api/pair", { body: { code, deviceName: "Phone" } });
  expect(claimed.status).toBe(200);
  const request = claimed.json.request as string;
  const waiting = send("GET", `/api/pair/${request}/wait`);
  await devices.decide(request, true);
  const done = await waiting;
  expect(done.json.state).toBe("approved");
  const set = String(done.headers["set-cookie"]);
  expect(set).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  return { cookie: set.split(";")[0]!, id: done.json.device.id };
}

async function start(extra: Partial<RemoteServerOptions> = {}) {
  hub = new EventHub(2000, 8 * 1024 * 1024, boot);
  server = new RemoteServer({
    devices,
    hub,
    cache: new IdempotencyCache(boot),
    scopeOf: (m) => (names.has(m) ? methodScope(m as HostMethod) : undefined),
    call: (ctx, method, args) => {
      calls.push({ method, args, client: ctx.client, clientId: ctx.clientId });
      if (method === "board.get") return { rev: 3 };
      if (method === "chat.list") throw new HostError("conflict", "nope", { rev: 1 });
      if (method === "atp.state") throw new Error("secret detail");
      return { ok: method };
    },
    context: (device, clientId) => ({ client: { device: device.id }, clientId, openExternal: () => undefined, authUpdate: () => undefined }),
    allowedHosts: () => [HOST],
    buildId: "b1",
    staticDir: join(dir, "mobile"),
    log: (line) => log.push(line),
    heartbeatMs: 40,
    ...extra,
  });
  await server.start(0);
  port = server.port!;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pigna-remote-"));
  mkdirSync(join(dir, "mobile", "assets"), { recursive: true });
  writeFileSync(join(dir, "mobile", "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dir, "mobile", "assets", "a.js"), "1");
  boot = "boot1";
  calls = [];
  log = [];
  devices = new DeviceStore(join(dir, "devices.json"), (list) => server?.devicesChanged(list));
  await start();
  ({ cookie, id: deviceId } = await pairDevice());
});

afterEach(async () => {
  await server.stop();
  await devices.flushed();
});

const post = (method: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  send("POST", `/api/call/${method}`, { body, cookie, headers: { "idempotency-key": "k" + Math.random(), ...headers } });

describe("RemoteServer", () => {
  it("listens only between start and stop", async () => {
    const idle = new RemoteServer({ ...(server as any).o });
    expect(idle.listening).toBe(false);
    await idle.start(0);
    expect(idle.listening).toBe(true);
    await idle.stop();
    expect(idle.listening).toBe(false);
    await expect(send("GET", "/api/hello")).resolves.toMatchObject({ status: 200 });
  });

  it("rejects other Host headers, even for the app shell", async () => {
    expect((await send("GET", "/", { host: "evil.example" })).status).toBe(403);
    expect((await send("GET", "/api/hello", { host: "127.0.0.1" })).status).toBe(403);
  });

  it("requires a device cookie and Tailscale login on everything but shell, hello and pairing", async () => {
    expect((await send("GET", "/api/events?stream=abcdefgh")).status).toBe(401);
    expect((await send("POST", "/api/call/board.get", { body: {}, headers: { "idempotency-key": "x" } })).status).toBe(401);
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie: "pigna_device=bogus" })).json.error.code).toBe("unauthorized");
    // Right cookie, wrong or missing Tailscale login.
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie, login: "other@example.com" })).status).toBe(401);
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie, login: null })).status).toBe(403);
    expect((await send("GET", "/")).status).toBe(200);
    const hello = await send("GET", "/api/hello");
    expect(hello.json).toMatchObject({ bootId: "boot1", build: "b1", authenticated: false });
    expect((await send("GET", "/api/hello", { cookie })).json.authenticated).toBe(true);
  });

  it("checks origin and client header on POST", async () => {
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie, csrf: false })).status).toBe(403);
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie, csrf: false, headers: { origin: "https://evil.example", "x-pigna-client": "1" } })).status).toBe(403);
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie, csrf: false, headers: { origin: `https://${HOST}` } })).status).toBe(403);
  });

  it("limits body size", async () => {
    const big = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) });
    const reply = await send("POST", "/api/call/board.apply", { body: big, cookie, headers: { "idempotency-key": "k" } });
    expect([413, 0]).toContain(reply.status);
  });

  it("dispatches calls with the device as client, logs method and status, never payloads", async () => {
    const reply = await post("board.get", { secret: "payload" }, { "x-pigna-stream": "stream-1" });
    expect(reply.json).toEqual({ rev: 3 });
    expect(calls[0]).toMatchObject({ method: "board.get", args: { secret: "payload" }, client: { device: deviceId }, clientId: "stream-1" });
    expect(log).toContain(`remote ${deviceId} board.get 200`);
    expect(log.join("\n")).not.toContain("payload");
  });

  it("refuses desktop-only and unknown methods, and non-allowlisted RPC", async () => {
    expect((await post("fs.pickFolder")).json.error.code).toBe("scope_denied");
    expect((await post("nope.nothing")).status).toBe(404);
    expect((await post("chat.command", { handle: "abc123", command: { type: "bash", command: "ls" } })).status).toBe(403);
    expect((await post("chat.command", { handle: "abc123", command: { type: "abort" } })).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["chat.command"]);
  });

  it("maps errors to the documented bodies and hides unexpected ones", async () => {
    const conflict = await post("chat.list");
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toMatchObject({ code: "conflict", detail: { rev: 1 } });
    const internal = await post("atp.state");
    expect(internal.status).toBe(500);
    expect(internal.text).not.toContain("secret detail");
  });

  it("needs an Idempotency-Key for mutations and runs a repeated key once", async () => {
    const none = await send("POST", "/api/call/board.apply", { body: {}, cookie });
    expect(none.status).toBe(400);
    const headers = { "idempotency-key": "same" };
    const a = await send("POST", "/api/call/board.apply", { body: { op: 1 }, cookie, headers });
    const b = await send("POST", "/api/call/board.apply", { body: { op: 1 }, cookie, headers });
    expect(a.json).toEqual(b.json);
    expect(calls.filter((c) => c.method === "board.apply")).toHaveLength(1);
    const changed = await send("POST", "/api/call/board.apply", { body: { op: 2 }, cookie, headers });
    expect(changed.json.error.detail.reason).toBe("idempotency_mismatch");
    const stale = await send("POST", "/api/call/board.apply", { body: { op: 1 }, cookie, headers: { "idempotency-key": "other", "x-pigna-boot": "old" } });
    expect(stale.json.error.code).toBe("host_restarted");
  });

  it("serves the shell with CSP and cache headers", async () => {
    const shell = await send("GET", "/");
    expect(shell.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(shell.headers["cache-control"]).toBe("no-cache");
    const asset = await send("GET", "/assets/a.js");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await send("GET", "/assets/missing.js")).status).toBe(404);
    expect((await send("GET", "/chat/abc")).text).toContain("<title>app</title>");
    expect((await send("GET", "/..%2f..%2fdevices.json")).status).not.toBe(200);
  });

  it("rate limits pairing and locks on wrong codes", async () => {
    devices.startPairing();
    const wrong = await send("POST", "/api/pair", { body: { code: "ZZZZZZZZ", deviceName: "x" } });
    expect(wrong.status).toBe(400);
    for (let i = 0; i < 12; i++) await send("POST", "/api/pair", { body: { code: "ZZZZZZZZ" } });
    expect((await send("POST", "/api/pair", { body: { code: "ZZZZZZZZ" } })).status).toBe(429);
  });

  describe("browser view", () => {
    const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);
    let push: (frame: { jpeg: Buffer; cssWidth: number; cssHeight: number }) => void;
    let closed: string[];
    let opened: Array<{ tab: string; viewer: unknown }>;

    async function withView() {
      await server.stop();
      closed = [];
      opened = [];
      await start({
        browserView: (tab, viewer, onFrame) => {
          if (tab === "nosuch") throw new Error("No browser tab nosuch");
          opened.push({ tab, viewer });
          push = onFrame;
          return { close: () => closed.push(tab) };
        },
      });
    }

    /** GET the frame stream and collect the raw body. */
    function view(path: string, headers: Record<string, string> = { cookie }) {
      let res!: IncomingMessage;
      let body = Buffer.alloc(0);
      const ready = new Promise<void>((resolve, reject) => {
        const req = httpRequest({ port, host: "127.0.0.1", path, headers: { host: HOST, "tailscale-user-login": LOGIN, ...headers } }, (r) => {
          res = r;
          r.on("data", (chunk: Buffer) => (body = Buffer.concat([body, chunk])));
          resolve();
        });
        req.on("error", reject);
        req.end();
      });
      return {
        ready,
        get res() {
          return res;
        },
        get text() {
          return body.toString("latin1");
        },
        close: () => res?.destroy(),
      };
    }
    const until = async (test: () => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (!test()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    it("streams multipart JPEG frames with the page size, and stops the source on disconnect", async () => {
      await withView();
      const v = view("/api/browser/view/tab1?w=390&h=844&dpr=3");
      await v.ready;
      expect(opened).toEqual([{ tab: "tab1", viewer: { width: 390, height: 844, dpr: 3 } }]);
      push({ jpeg: jpeg(1), cssWidth: 390, cssHeight: 844 });
      await until(() => v.text.includes("X-Css-Height: 844"));
      expect(v.res.headers["content-type"]).toBe("multipart/x-mixed-replace; boundary=pigna-frame");
      expect(v.text).toContain("Content-Type: image/jpeg");
      expect(v.text).toContain("X-Css-Width: 390");
      v.close();
      await until(() => closed.length === 1);
      expect(closed).toEqual(["tab1"]);
    });

    it("delivers only the newest of a burst", async () => {
      await withView();
      const v = view("/api/browser/view/tab1");
      await v.ready;
      for (let n = 1; n <= 20; n++) push({ jpeg: jpeg(n), cssWidth: 100, cssHeight: 100 });
      await until(() => v.text.includes("--pigna-frame"));
      await new Promise((r) => setTimeout(r, 150));
      const parts = v.text.split("--pigna-frame").length - 1;
      expect(parts).toBeLessThan(20);
      expect(v.text).toContain("\xff\xd8\x14\xff\xd9"); // frame 20 arrived
      v.close();
    });

    it("answers errors as JSON before any frame, and needs a paired device", async () => {
      await withView();
      const unknown = await send("GET", "/api/browser/view/nosuch", { cookie });
      expect(unknown.status).toBe(404);
      expect((await send("GET", "/api/browser/view/tab1")).status).toBe(401);
      expect((await send("GET", "/api/browser/view/bad%20id", { cookie })).status).toBe(404);
      expect(opened).toEqual([]);
    });

    it("closes the stream and its source when the device is revoked or the server stops", async () => {
      await withView();
      const v = view("/api/browser/view/tab1");
      await v.ready;
      push({ jpeg: jpeg(1), cssWidth: 1, cssHeight: 1 });
      await until(() => v.text.includes("--pigna-frame"));
      await devices.revoke(deviceId);
      await until(() => closed.length === 1);
      const w = view("/api/browser/view/tab2", { cookie: (await pairDevice()).cookie });
      await w.ready;
      await server.stop();
      await until(() => closed.length === 2);
    });
  });

  describe("events", () => {
    it("says hello, replays after Last-Event-ID and heartbeats", async () => {
      hub.publish("global", { kind: "one" });
      hub.publish("global", { kind: "two" });
      const s = sse("/api/events?stream=stream-aaaa", cookie, { "last-event-id": "boot1:1" });
      await s.ready;
      await s.until(() => s.frames.some((f) => f.includes('"two"')));
      expect(s.frames[0]).toContain("event: hello");
      expect(s.frames.some((f) => f.includes('"one"'))).toBe(false);
      expect(s.frames.find((f) => f.includes('"two"'))).toContain("id: boot1:2");
      hub.publish("global", { kind: "three" });
      await s.until(() => s.frames.some((f) => f.includes('"three"')));
      await s.until(() => s.frames.includes(": hb"));
      s.close();
    });

    it("sends login progress to the requesting stream only, as an unsequenced client event", async () => {
      const mine = sse("/api/events?stream=stream-aaaa", cookie);
      const other = sse("/api/events?stream=stream-bbbb", cookie);
      await Promise.all([mine.ready, other.ready]);
      const latest = hub.latest;
      const update = { kind: "event", event: { type: "device_code", userCode: "AB-12", verificationUri: "https://x.test/device" } };
      expect(server.notify("stream-aaaa", deviceId, { kind: "providers.login", update })).toBe(true);
      await mine.until(() => mine.frames.some((f) => f.startsWith("event: client")));
      expect(mine.frames.find((f) => f.startsWith("event: client"))).toContain('"userCode":"AB-12"');
      expect(other.frames.some((f) => f.includes("AB-12"))).toBe(false);
      expect(hub.latest).toBe(latest);
      // Another device's id, or a stream that is not open, gets nothing.
      expect(server.notify("stream-aaaa", "someone-else", {})).toBe(false);
      expect(server.notify("stream-zzzz", deviceId, {})).toBe(false);
      mine.close();
      other.close();
    });

    it("sends resync for unknown boots, missing ids and gaps", async () => {
      const a = sse("/api/events?stream=stream-aaaa", cookie);
      const b = sse("/api/events?stream=stream-bbbb", cookie, { "last-event-id": "other:5" });
      await Promise.all([a.ready, b.ready]);
      await a.until(() => a.frames.some((f) => f.startsWith("event: resync")));
      await b.until(() => b.frames.some((f) => f.includes("new_boot")));
      a.close();
      b.close();
    });

    it("delivers chat topics only to subscribed streams", async () => {
      const s = sse("/api/events?stream=stream-aaaa", cookie);
      await s.ready;
      hub.publish("chat:abc123", { type: "x1" });
      expect((await post("board.get")).status).toBe(200);
      const sub = await send("POST", "/api/subscribe", { body: { stream: "stream-aaaa", chats: ["abc123"] }, cookie });
      expect(sub.status).toBe(200);
      hub.publish("chat:abc123", { type: "x2" });
      hub.publish("chat:zzz999", { type: "x3" });
      hub.publish("global", { kind: "g" });
      await s.until(() => s.frames.some((f) => f.includes('"g"')));
      const text = s.frames.join("\n");
      expect(text).toContain("x2");
      expect(text).not.toContain("x1");
      expect(text).not.toContain("x3");
      expect((await send("POST", "/api/subscribe", { body: { stream: "nope-nope", chats: [] }, cookie })).status).toBe(404);
      s.close();
    });

    it("stops writing under backpressure and resyncs once drained", async () => {
      await server.stop();
      await start({ streamCap: 64 * 1024, streamHardMs: 60_000 });
      ({ cookie } = await pairDevice());
      const s = sse("/api/events?stream=stream-aaaa", cookie);
      await s.ready;
      s.res.pause();
      const filler = "x".repeat(512 * 1024);
      for (let i = 0; i < 80; i++) hub.publish("global", { kind: "fill", i, filler });
      await new Promise((r) => setTimeout(r, 100));
      s.res.resume();
      await s.until(() => s.frames.some((f) => f.startsWith("event: resync")), 8000);
      const delivered = s.frames.filter((f) => f.includes('"fill"')).length;
      expect(delivered).toBeLessThan(80);
      s.close();
    });

    it("never queues more than its cap for a stalled consumer, and goes live again after the resync", async () => {
      await server.stop();
      await start({ streamCap: 64 * 1024, streamHardMs: 60_000 });
      ({ cookie } = await pairDevice());
      const s = sse("/api/events?stream=stream-aaaa", cookie);
      await s.ready;
      s.res.pause();
      const filler = "x".repeat(256 * 1024);
      const total = 400;
      for (let i = 0; i < total; i++) hub.publish("global", { kind: "fill", i, filler });
      await new Promise((r) => setTimeout(r, 100));
      // What the kernel and the client's socket hold is bounded by the cap plus a frame or two, not by the 100 MiB published.
      const queued = server.streamQueuedBytes;
      expect(queued).toBeLessThan(64 * 1024 + 2 * filler.length);
      s.res.resume();
      await s.until(() => s.frames.some((f) => f.startsWith("event: resync")), 8000);
      const before = s.frames.length;
      hub.publish("global", { kind: "after" });
      await s.until(() => s.frames.slice(before).some((f) => f.includes('"after"')));
      s.close();
    });

    it("tells clients of a restarted host to resync, and refuses their old keys", async () => {
      const keyed = { "idempotency-key": "once", "x-pigna-boot": "boot1" };
      expect((await send("POST", "/api/call/board.apply", { body: { op: 1 }, cookie, headers: keyed })).status).toBe(200);
      hub.publish("global", { kind: "one" });
      await server.stop();
      boot = "boot2";
      await start();
      calls = [];
      // The same cookie still works (devices persist); the key does not: its first run may or may not have happened.
      const retry = await send("POST", "/api/call/board.apply", { body: { op: 1 }, cookie, headers: keyed });
      expect(retry.status).toBe(409);
      expect(retry.json.error.code).toBe("host_restarted");
      expect(calls).toHaveLength(0);
      const s = sse("/api/events?stream=stream-aaaa", cookie, { "last-event-id": "boot1:1" });
      await s.ready;
      await s.until(() => s.frames.some((f) => f.includes("new_boot")));
      expect(s.frames.some((f) => f.includes("boot1:"))).toBe(false);
      expect(s.frames.some((f) => f.startsWith("id: boot2:"))).toBe(false);
      s.close();
    });

    it("closes a revoked device's stream at once", async () => {
      const s = sse("/api/events?stream=stream-aaaa", cookie);
      await s.ready;
      await s.until(() => server.streamCount === 1);
      await devices.revoke(deviceId);
      await s.until(() => s.ended);
      expect(server.streamCount).toBe(0);
    });
  });
});
