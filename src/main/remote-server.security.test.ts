// Security boundaries of the remote surface, against a real RemoteServer, DeviceStore and the real HostCore method
// table (its dependencies faked). Routes are enumerated from the table, so a new method is covered automatically.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", getPath: () => "/tmp" }, shell: {}, dialog: {} }));

import { HostError, MAX_JSON_BODY_BYTES, PAIRING_APPROVAL_TIMEOUT_MS, PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS, methodScope, type HostMethod } from "../shared/host-api";
import { AgentBridge } from "./bridge";
import { IdempotencyCache } from "./command-layer";
import { DeviceStore, hashToken } from "./devices";
import { EventHub } from "./event-hub";
import { scrub } from "./github";
import { createHostCore, dispatch, type HostDeps } from "./host-core";
import { RemoteServer } from "./remote-server";

const HOST = "mac.tail.ts.net";
const LOGIN = "me@example.com";
const CARRIER = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
const PAT = "github_pat_" + "0123456789abcdefABCDEF_xyz";

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  text: string;
  json: any;
}

let port = 0;
const send = (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; cookie?: string; login?: string | null; csrf?: boolean } = {}) =>
  new Promise<Reply>((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, ...opts.headers };
    if (opts.login !== null) headers["tailscale-user-login"] = opts.login ?? LOGIN;
    if (opts.cookie) headers.cookie = opts.cookie;
    if (method === "POST" && opts.csrf !== false) Object.assign(headers, { origin: `https://${HOST}`, "x-pigna-client": "1" }, opts.headers);
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
    // The server may answer 413 and hang up while a big body is still being written: the reply can be lost (status 0).
    req.on("error", (error: NodeJS.ErrnoException) => (error.code === "EPIPE" || error.code === "ECONNRESET" ? resolve({ status: 0, headers: {}, text: "", json: undefined }) : reject(error)));
    req.end(text);
  });

const who = (deviceName = "x") => ({ deviceName, userAgent: "", tailnetLogin: LOGIN });
const record = (value: unknown) => () => Promise.resolve(value);
const deps = {
  shellEnv: Promise.resolve(),
  host: {},
  tasks: {},
  board: { get: record({ rev: 1 }) },
  cardImages: {},
  settings: { get: record({ rev: 1, theme: "dark" }) },
  uiState: {},
  computerPolicy: {},
  computerHelper: {},
  laments: {},
  github: { project: record({ accounts: [{ login: "me" }] }) },
  atp: {},
  auth: {},
  browser: () => undefined,
  updater: () => undefined,
  native: {},
} as unknown as HostDeps;
const core = createHostCore(deps);
/** Methods the table does not hold yet (the devices.* family arrives with the wiring node). */
const EXTRA = ["devices.list", "devices.revoke"];
const methodNames = [...Object.keys(core), ...EXTRA];

let dir: string;
let devices: DeviceStore;
let hub: EventHub;
let server: RemoteServer;
let cookie: string;
let deviceId: string;
let token: string;
let log: string[];
let clock = 1_700_000_000_000;

async function pairWith(store: DeviceStore) {
  store.startPairing();
  const claimed = await send("POST", "/api/pair", { body: { code: store.pairingStatus().code, deviceName: "Phone" } });
  expect(claimed.status).toBe(200);
  const waiting = send("GET", `/api/pair/${claimed.json.request}/wait`);
  await store.decide(claimed.json.request, true);
  const done = await waiting;
  const set = String(done.headers["set-cookie"]);
  return { cookie: set.split(";")[0]!, id: done.json.device.id as string, token: set.split(";")[0]!.split("=")[1]! };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pigna-security-"));
  mkdirSync(join(dir, "mobile"), { recursive: true });
  writeFileSync(join(dir, "mobile", "index.html"), "<!doctype html><title>app</title>");
  log = [];
  hub = new EventHub(2000, 8 * 1024 * 1024, "boot1");
  devices = new DeviceStore(join(dir, "devices.json"), (list) => server?.devicesChanged(list), undefined, { now: () => clock });
  server = new RemoteServer({
    devices,
    hub,
    cache: new IdempotencyCache("boot1"),
    scopeOf: (m) => (methodNames.includes(m) ? methodScope(m as HostMethod) : undefined),
    call: async (ctx, method, args) => {
      if (method === "devices.list") return devices.list();
      if (method === "devices.revoke") return devices.revoke((args as { id: string }).id);
      return dispatch(core, { client: ctx.client, clientId: ctx.clientId, openExternal: ctx.openExternal, authUpdate: ctx.authUpdate } as never, method, args);
    },
    context: (device, clientId) => ({ client: { device: device.id }, clientId, openExternal: () => undefined, authUpdate: () => undefined }),
    allowedHosts: () => [HOST],
    buildId: "b1",
    staticDir: join(dir, "mobile"),
    log: (line) => log.push(line),
    heartbeatMs: 40,
  });
  await server.start(0);
  port = server.port!;
  ({ cookie, id: deviceId, token } = await pairWith(devices));
});

afterEach(async () => {
  await server.stop();
  await devices.flushed();
});

const call = (method: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  send("POST", `/api/call/${method}`, { body, cookie, headers: { "idempotency-key": "k" + Math.random(), ...headers } });

describe("remote security: authentication", () => {
  it("answers 401 to every method in the table without a device cookie", async () => {
    expect(methodNames.length).toBeGreaterThan(40);
    for (const method of methodNames) {
      const bare = await send("POST", `/api/call/${method}`, { body: {}, headers: { "idempotency-key": "x" } });
      expect(bare.status, method).toBe(401);
      const wrong = await send("POST", `/api/call/${method}`, { body: {}, cookie: "pigna_device=nope", headers: { "idempotency-key": "x" } });
      expect(wrong.status, method).toBe(401);
    }
    for (const path of ["/api/events?stream=abcdefgh", "/api/nothing"]) expect((await send("GET", path)).status, path).toBe(401);
    expect((await send("POST", "/api/subscribe", { body: { stream: "abcdefgh", chats: [] } })).status).toBe(401);
  });

  it("refuses wrong Host, foreign or missing Origin and a missing client header on mutations", async () => {
    for (const host of ["evil.example", "127.0.0.1", "mac.tail.ts.net.evil.example", ""]) {
      expect((await send("GET", "/api/hello", { headers: { host } })).status, host).toBe(403);
      expect((await send("POST", "/api/call/board.get", { body: {}, cookie, headers: { host } })).status, host).toBe(403);
    }
    const base = { body: {}, cookie, csrf: false };
    expect((await send("POST", "/api/call/board.get", base)).status).toBe(403);
    expect((await send("POST", "/api/call/board.get", { ...base, headers: { "x-pigna-client": "1" } })).status).toBe(403);
    for (const origin of ["https://evil.example", "null", `http://${HOST}`, `https://${HOST}.evil.example`]) {
      expect((await send("POST", "/api/call/board.get", { ...base, headers: { origin, "x-pigna-client": "1" } })).status, origin).toBe(403);
    }
    expect((await send("POST", "/api/call/board.get", { ...base, headers: { origin: `https://${HOST}` } })).status).toBe(403);
    expect((await send("POST", "/api/call/board.get", { ...base, headers: { origin: `https://${HOST}`, "x-pigna-client": "1" } })).status).toBe(200);
  });

  it("refuses a missing or different Tailscale login, even with a valid cookie", async () => {
    expect((await send("POST", "/api/call/board.get", { body: {}, cookie, login: null })).status).toBe(403);
    for (const login of ["other@example.com", "", "ME@example.com"]) {
      const reply = await send("POST", "/api/call/board.get", { body: {}, cookie, login });
      expect([401, 403], `login ${JSON.stringify(login)}`).toContain(reply.status);
    }
    const events = await send("GET", "/api/events?stream=abcdefgh", { cookie, login: "other@example.com" });
    expect([401, 403]).toContain(events.status);
  });

  it("does not accept an AgentBridge token as a cookie or a bearer, and the bridge accepts only its own tokens", async () => {
    const bridge = new AgentBridge();
    bridge.route("/kanban/list", async () => ({ ok: true }));
    await bridge.start();
    try {
      const bridgeToken = bridge.register("handle1");
      for (const headers of [{ cookie: `pigna_device=${bridgeToken}` } as Record<string, string>, { authorization: `Bearer ${bridgeToken}` } as Record<string, string>]) {
        const reply = await send("POST", "/api/call/board.get", { body: {}, headers });
        expect(reply.status).toBe(401);
      }
      // The bridge answers on its own loopback port and refuses the device's token, remote Host names and no token.
      const url = new URL(bridge.url);
      const ask = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port: Number(url.port), method: "POST", path: "/kanban/list", headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
          req.on("error", reject);
          req.end("{}");
        });
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).not.toBe(port);
      expect(await ask({ host: url.host, authorization: `Bearer ${bridgeToken}` })).toBe(200);
      expect(await ask({ host: url.host, authorization: `Bearer ${token}` })).toBe(401);
      expect(await ask({ host: url.host, cookie: `pigna_device=${token}` })).toBe(401);
      expect(await ask({ host: HOST, authorization: `Bearer ${bridgeToken}` })).toBe(403);
      // The remote server does not serve bridge routes.
      expect((await send("POST", "/kanban/list", { body: {}, cookie })).status).toBeGreaterThanOrEqual(400);
    } finally {
      bridge.stop();
    }
  });

  it("closes a revoked device's stream within a second and refuses its next call", async () => {
    const frames: string[] = [];
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ port, host: "127.0.0.1", path: "/api/events?stream=stream-aaaa", headers: { host: HOST, cookie, "tailscale-user-login": LOGIN } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => frames.push(c));
        res.on("end", () => (ended = true));
        res.on("close", () => (ended = true));
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
    const wait = async (test: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    await wait(() => server.streamCount === 1, 2000);
    expect(server.streamCount).toBe(1);
    expect((await call("board.get")).status).toBe(200);
    const revokedAt = Date.now();
    await call("devices.revoke", { id: deviceId });
    await wait(() => ended, 1000);
    expect(ended).toBe(true);
    expect(Date.now() - revokedAt).toBeLessThan(1000);
    expect((await call("board.get")).status).toBe(401);
    expect((await send("GET", "/api/events?stream=stream-bbbb", { cookie })).status).toBe(401);
  });
});

describe("remote security: pairing", () => {
  it("issues no token without the Mac's approval, and a denial issues none either", async () => {
    const fresh = new DeviceStore(join(dir, "other.json"), () => undefined, undefined, { now: () => clock });
    server.devicesChanged([]);
    fresh.startPairing();
    const claim = fresh.claim(fresh.pairingStatus().code!, who());
    expect(claim.ok).toBe(true);
    const request = (claim as { request: string }).request;
    expect(fresh.waitFor(request)).toEqual({ state: "pending_approval" });
    await fresh.decide(request, false);
    expect(fresh.waitFor(request)).toEqual({ state: "denied" });
    expect(await fresh.list()).toEqual([]);
  });

  it("over HTTP, an unapproved request sets no cookie and a guessed request id gets nothing", async () => {
    devices.startPairing();
    const claimed = await send("POST", "/api/pair", { body: { code: devices.pairingStatus().code, deviceName: "Phone 2" } });
    const request = claimed.json.request as string;
    const guess = await send("GET", "/api/pair/00000000-0000-0000-0000-000000000000/wait");
    expect(guess.headers["set-cookie"]).toBeUndefined();
    expect(guess.json.state).toBe("expired");
    // Approval times out: nothing is issued afterwards.
    clock += PAIRING_APPROVAL_TIMEOUT_MS + 1;
    const late = await send("GET", `/api/pair/${request}/wait`);
    expect(late.headers["set-cookie"]).toBeUndefined();
    expect(late.json.state).toBe("expired");
    expect(await devices.list()).toHaveLength(1);
  });

  it("limits attempts, expires codes and accepts a code once", async () => {
    // Attempts: the code dies after PAIRING_MAX_ATTEMPTS wrong tries, even when the right one comes next.
    devices.startPairing();
    const good = devices.pairingStatus().code!;
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) expect(devices.claim("ZZZZZZZZ", who()).ok).toBe(false);
    expect(devices.claim(good, who())).toEqual({ ok: false, reason: "locked" });
    expect(devices.pairingStatus().state).toBe("locked");
    // Expiry.
    devices.startPairing();
    const old = devices.pairingStatus().code!;
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(devices.claim(old, who())).toEqual({ ok: false, reason: "invalid" });
    // Single use, and a new code replaces the old one.
    devices.startPairing();
    const first = devices.pairingStatus().code!;
    expect(devices.claim(first, who()).ok).toBe(true);
    expect(devices.claim(first, who()).ok).toBe(false);
    devices.startPairing();
    const second = devices.pairingStatus().code!;
    devices.startPairing();
    expect(devices.claim(second, who()).ok).toBe(false);
  });

  it("brute force over HTTP ends in 429 and the real code stays unusable", async () => {
    devices.startPairing();
    const code = devices.pairingStatus().code!;
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) seen.add((await send("POST", "/api/pair", { body: { code: "ZZZZZZZZ", deviceName: "x" } })).status);
    expect(seen.has(429)).toBe(true);
    const real = await send("POST", "/api/pair", { body: { code, deviceName: "x" } });
    expect(real.status).toBe(429);
    expect(real.json.request).toBeUndefined();
    expect((await send("POST", "/api/pair", { body: { code }, login: "other@example.com" })).json?.request).toBeUndefined();
  });

  it("stores only a hash of the device token", async () => {
    const stored = JSON.stringify(await (devices as any).store.get());
    expect(stored).not.toContain(token);
    expect(stored).toContain(hashToken(token));
  });
});

describe("remote security: leakage", () => {
  const tokenShaped = (text: string) => [CARRIER, PAT, token, hashToken(token)].filter((secret) => text.includes(secret)).concat(/\b(?:gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/.test(text) ? ["pattern"] : []);

  it("keeps device tokens and hashes out of devices.*, settings.*, github.* and error bodies", async () => {
    for (const [method, body] of [["devices.list", {}], ["settings.get", {}], ["github.project", { cwd: "/tmp" }], ["board.get", {}], ["nope.nothing", {}], ["chat.command", { handle: "x" }]] as const) {
      const reply = await call(method, body);
      expect(tokenShaped(reply.text), method).toEqual([]);
      expect(JSON.stringify(reply.headers)).not.toContain(token);
    }
    expect((await call("devices.list")).text).not.toMatch(/tokenHash|token"/);
    const hello = await send("GET", "/api/hello", { cookie });
    expect(tokenShaped(hello.text)).toEqual([]);
    expect(log.join("\n")).not.toContain(token);
  });

  it("masks token-shaped strings in what github.ts lets out", () => {
    expect(scrub(`failed ${CARRIER} and ${PAT}`, [])).toBe("failed *** and ***");
    expect(scrub("known-secret-value in text", ["known-secret-value"])).toBe("*** in text");
  });

  it("does not echo a thrown error's detail", async () => {
    const reply = await call("github.project", { cwd: "relative" });
    expect(reply.status).toBe(400);
    expect(reply.text).not.toMatch(/at .*\.ts:\d+/);
  });
});

describe("remote security: input limits and allowlists", () => {
  it("rejects oversized bodies (413) and malformed JSON (400) on every route kind", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_JSON_BODY_BYTES + 10) });
    for (const path of ["/api/call/board.apply", "/api/pair", "/api/subscribe"]) {
      const reply = await send("POST", path, { body: big, cookie, headers: { "idempotency-key": "k" } });
      expect([413, 0], path).toContain(reply.status);
    }
    for (const text of ["{", "not json", "[1,", '{"a":']) expect((await send("POST", "/api/call/settings.get", { body: text, cookie })).status, text).toBe(400);
    // The server is still healthy afterwards.
    expect((await call("board.get")).status).toBe(200);
  });

  it("rejects non-object or hostile arguments as bad requests, never 500s", async () => {
    for (const body of [null, 1, "x", [], { cwd: 5 }, { cwd: "../../etc" }, { cwd: "/tmp\u0000/x" }, { __proto__: { a: 1 } }]) {
      const reply = await call("github.project", body);
      expect(reply.status, JSON.stringify(body)).toBeLessThan(500);
    }
    expect((await call("__proto__")).status).toBe(404);
    expect((await call("constructor")).status).toBe(404);
    expect((await call("toString")).status).toBe(404);
  });

  it("does not let a remote client read files by path (fs.describePaths is desktop-only)", async () => {
    const secret = join(dir, "secret.png");
    writeFileSync(secret, "not really an image");
    const reply = await call("fs.describePaths", { paths: [secret, "/etc/hosts"] });
    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain("secret.png");
    for (const method of ["fs.pickFolder", "fs.pickAttachments", "fs.browseFolders"]) expect([403, 404], method).toContain((await call(method)).status);
  });

  it("refuses desktop-only methods remotely, whatever the arguments", async () => {
    for (const method of methodNames.filter((m) => methodScope(m as HostMethod) === "desktop")) {
      const reply = await call(method, { anything: true });
      expect(reply.status, method).toBe(403);
      expect(reply.json.error.code).toBe("scope_denied");
    }
  });

  it("enforces the RPC allowlist for chat.command", async () => {
    for (const type of ["bash", "new_session", "switch_session", "fork", "export_html", "set_auto_compaction_and_bash", undefined, 5]) {
      const reply = await call("chat.command", { handle: "abc123", command: { type } });
      expect(reply.status, String(type)).toBe(403);
    }
    expect((await call("chat.command", { handle: "abc123" })).status).toBe(403);
    expect((await call("chat.command", { handle: "abc123", command: null })).status).toBe(403);
    expect([403, 404]).toContain((await call("chat.rawCommand", { handle: "abc123", command: { type: "bash", command: "id" } })).status);
  });
});

describe("HostCore error mapping", () => {
  it("turns validation failures into bad_request", () => {
    expect(() => dispatch(core, { client: { device: "d" }, clientId: "c", openExternal: () => undefined, authUpdate: () => undefined } as never, "github.project", { cwd: "relative" })).toThrow(HostError);
  });
});
