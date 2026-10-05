// The only network surface for remote clients: plain node:http on 127.0.0.1 (Tailscale serve fronts it), started
// only while remote access is on. Every request is checked in the same order (REMOTE.md s.11): Host, body size,
// device cookie, CSRF headers, Tailscale login. AgentBridge tokens are never looked at here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_S,
  HEADER_BOOT,
  HEADER_CLIENT,
  HEADER_IDEMPOTENCY,
  HEARTBEAT_MS,
  HostError,
  MAX_JSON_BODY_BYTES,
  REMOTE_CSP,
  isAllowedRpc,
  methodMutates,
  parseEventId,
  type DeviceInfo,
  type HostMethod,
  type MethodScope,
  type Topic,
} from "../shared/host-api";
import type { HostContext } from "./host-core";
import type { DeviceStore } from "./devices";
import type { EventHub, HubEnvelope, Subscription } from "./event-hub";
import type { IdempotencyCache } from "./command-layer";

/** A call may name the SSE stream it belongs to (its client id for leases); without it the device id is used. */
export const HEADER_STREAM = "x-pigna-stream";
const HEADER_LOGIN = "tailscale-user-login";

/** Backpressure (REMOTE.md s.4): stop writing above the cap, resync once drained, close if still far over after the grace. */
export const STREAM_CAP_BYTES = 1024 * 1024;
export const STREAM_HARD_CAP_BYTES = 4 * 1024 * 1024;
export const STREAM_HARD_MS = 10_000;

const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX_PER_WINDOW = 10;
const PAIR_WAIT_MS = 25_000;
const STREAM_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CHAT_HANDLE = /^[a-z0-9]{6,32}$/;

export interface RemoteServerOptions {
  devices: DeviceStore;
  hub: EventHub;
  cache: IdempotencyCache;
  /** Runs one method (`dispatch` over the HostCore table); unknown or desktop-only names throw. */
  call(ctx: HostContext, method: string, args: unknown): unknown;
  /** Scope of a method, undefined when unknown. */
  scopeOf(method: string): MethodScope | undefined;
  /** The context for a remote caller: openExternal is a no-op, authUpdate goes to that client. */
  context(device: DeviceInfo, clientId: string): HostContext;
  /** Host header values accepted, e.g. the tailnet name; loopback names only for local testing. */
  allowedHosts(): string[];
  buildId: string;
  /** `out/mobile`; a placeholder page is served until it exists. */
  staticDir?: string;
  /** Audit line, names and statuses only. */
  log?(line: string): void;
  /** A stream opened or closed, so leases can start or end their grace. */
  onStream?(event: "open" | "close", clientId: string, deviceId: string): void;
  /** Tests: do not demand Tailscale-User-Login. */
  requireLogin?: boolean;
  heartbeatMs?: number;
  streamCap?: number;
  streamHardCap?: number;
  streamHardMs?: number;
  now?: () => number;
}

interface Stream {
  id: string;
  device: string;
  res: ServerResponse;
  sub: Subscription;
  heartbeat: NodeJS.Timeout;
  paused: boolean;
  hardTimer?: NodeJS.Timeout;
}

interface Caller {
  device: DeviceInfo;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const PLACEHOLDER = "<!doctype html><meta charset=utf-8><title>pi-gna</title><body style=\"font:16px system-ui;padding:2rem\"><h1>pi-gna remote</h1><p>The mobile app is not built yet.</p>";

const readCookie = (header: string | undefined, name: string): string | undefined => {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
};

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export class RemoteServer {
  private server?: Server;
  private readonly streams = new Map<string, Stream>();
  private readonly pairHits = new Map<string, number[]>();

  constructor(private readonly o: RemoteServerOptions) {}

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** The bound port (useful when started on 0). */
  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  start(port: number): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", (error) => {
        this.server = undefined;
        reject(error);
      });
      server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  /** Closes every stream and stops listening (remote turned off, or quit). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const stream of [...this.streams.values()]) this.closeStream(stream, "server_stopped");
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** Wire to `DeviceStore`'s `changed`: streams of devices that are gone close at once. */
  devicesChanged(devices: DeviceInfo[]): void {
    const live = new Set(devices.map((d) => d.id));
    for (const stream of [...this.streams.values()]) if (!live.has(stream.device)) this.closeStream(stream, "revoked");
  }

  get streamCount(): number {
    return this.streams.size;
  }

  /** Bytes waiting in the largest stream write queue: what a stalled consumer costs the host's memory. */
  get streamQueuedBytes(): number {
    let most = 0;
    for (const stream of this.streams.values()) most = Math.max(most, stream.res.writableLength);
    return most;
  }

  // ── Request pipeline ───────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      const path = url.pathname;
      const host = (header(req, "host") ?? "").toLowerCase();
      if (!this.o.allowedHosts().some((h) => h.toLowerCase() === host)) throw new HostError("forbidden", "unexpected Host");

      if (!path.startsWith("/api/")) return await this.serveStatic(req, res, path);
      this.apiHeaders(res);
      const post = req.method === "POST";
      if (!post && req.method !== "GET") throw new HostError("bad_request", "method not allowed");
      if (post) this.csrf(req, host);

      if (path === "/api/hello" && !post) return this.json(res, 200, await this.hello(req));
      if (path === "/api/pair" && post) return this.json(res, 200, await this.pair(req, await this.body(req)));
      const wait = /^\/api\/pair\/([A-Za-z0-9-]{1,64})\/wait$/.exec(path);
      if (wait && !post) return await this.pairWait(req, res, wait[1]!);

      const caller = await this.authenticate(req);
      if (path === "/api/events" && !post) return this.events(req, res, url, caller);
      if (path === "/api/subscribe" && post) return this.json(res, 200, this.subscribe(caller, await this.body(req)));
      const call = /^\/api\/call\/([A-Za-z0-9_.-]{1,64})$/.exec(path);
      if (call && post) return await this.callMethod(req, res, caller, call[1]!);
      throw new HostError("not_found", "unknown route");
    } catch (error) {
      this.fail(res, error);
    }
  }

  private apiHeaders(res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
  }

  /** Mutating requests: same-origin Origin and the custom header (SameSite=Strict is the first line). */
  private csrf(req: IncomingMessage, host: string) {
    const origin = header(req, "origin");
    let originHost: string | undefined;
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : undefined;
    } catch {
      // malformed origin stays undefined
    }
    // Tailscale serve fronts this with HTTPS only; the Secure cookie would not travel over http anyway.
    if (originHost !== host || new URL(origin!).protocol !== "https:") throw new HostError("forbidden", "cross-origin request");
    if (header(req, HEADER_CLIENT) !== "1") throw new HostError("forbidden", "missing client header");
  }

  private login(req: IncomingMessage): string | undefined {
    const login = header(req, HEADER_LOGIN);
    if (this.o.requireLogin !== false && !login) throw new HostError("forbidden", "not reached through Tailscale");
    return login;
  }

  private async authenticate(req: IncomingMessage): Promise<Caller> {
    const login = this.login(req);
    const device = await this.o.devices.authenticate(readCookie(header(req, "cookie"), DEVICE_COOKIE), login);
    if (!device) throw new HostError("unauthorized", "not paired");
    return { device };
  }

  private async body(req: IncomingMessage): Promise<any> {
    const text = await this.rawBody(req);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HostError("bad_request", "invalid JSON");
    }
  }

  private rawBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const length = Number(header(req, "content-length") ?? 0);
      if (length > MAX_JSON_BODY_BYTES) return reject(new HostError("payload_too_large", "body too large"));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES) {
          chunks.length = 0;
          req.pause();
          reject(new HostError("payload_too_large", "body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, value: unknown, extra: Record<string, string | string[]> = {}) {
    const text = JSON.stringify(value ?? null);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...extra });
    res.end(text);
  }

  private fail(res: ServerResponse, error: unknown) {
    const known = error instanceof HostError ? error : undefined;
    if (!known) this.o.log?.(`remote internal error: ${error instanceof Error ? error.message : String(error)}`);
    const e = known ?? new HostError("internal", "internal error");
    if (res.headersSent) return void res.end();
    this.apiHeaders(res);
    const text = JSON.stringify({ error: e.toBody() });
    res.writeHead(e.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      ...(e.code === "payload_too_large" ? { Connection: "close" } : {}),
      ...(e.detail?.retryAfter ? { "Retry-After": String(e.detail.retryAfter) } : {}),
    });
    res.end(text);
  }

  // ── Routes ─────────────────────────────────────────────────────────────────

  private async hello(req: IncomingMessage) {
    const device = await this.o.devices.authenticate(readCookie(header(req, "cookie"), DEVICE_COOKIE), header(req, HEADER_LOGIN));
    return { buildId: this.o.buildId, build: this.o.buildId, bootId: this.o.hub.bootId, authenticated: device !== null };
  }

  private rateLimit(key: string) {
    const now = (this.o.now ?? Date.now)();
    const hits = (this.pairHits.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS);
    if (hits.length >= PAIR_MAX_PER_WINDOW) throw new HostError("rate_limited", "too many pairing attempts", { retryAfter: Math.ceil((PAIR_WINDOW_MS - (now - hits[0]!)) / 1000) });
    hits.push(now);
    this.pairHits.set(key, hits);
  }

  private async pair(req: IncomingMessage, body: any) {
    const login = this.login(req) ?? "";
    // The global bucket stops a scan from many sources; the per-source one is the tailnet login (the socket is always loopback).
    this.rateLimit("*");
    this.rateLimit(`login:${login}`);
    const result = this.o.devices.claim(String(body?.code ?? ""), { deviceName: String(body?.deviceName ?? ""), userAgent: header(req, "user-agent") ?? "", tailnetLogin: login });
    if (!result.ok) {
      if (result.reason === "locked") throw new HostError("rate_limited", "pairing is locked; ask for a new code on the Mac", { retryAfter: 300 });
      throw new HostError("bad_request", "invalid pairing code");
    }
    return { request: result.request };
  }

  private async pairWait(req: IncomingMessage, res: ServerResponse, request: string) {
    this.login(req);
    const end = (this.o.now ?? Date.now)() + PAIR_WAIT_MS;
    let closed = false;
    req.on("close", () => (closed = true));
    for (;;) {
      const result = this.o.devices.waitFor(request);
      if (result.state === "approved") {
        const cookie = `${DEVICE_COOKIE}=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`;
        return this.json(res, 200, { state: "approved", device: result.device }, { "Set-Cookie": cookie });
      }
      if (result.state !== "pending_approval" || closed || (this.o.now ?? Date.now)() >= end) return this.json(res, 200, { state: result.state });
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async callMethod(req: IncomingMessage, res: ServerResponse, caller: Caller, method: string) {
    const deviceId = caller.device.id;
    let status = 200;
    try {
      const scope = this.o.scopeOf(method);
      if (!scope) throw new HostError("not_found", `unknown method ${method}`);
      if (scope === "desktop") throw new HostError("scope_denied", `${method} is only available on the Mac`);
      const text = await this.rawBody(req);
      let args: any;
      try {
        args = text ? JSON.parse(text) : {};
      } catch {
        throw new HostError("bad_request", "invalid JSON");
      }
      if (method === "chat.command" && !isAllowedRpc(args?.command ?? {})) throw new HostError("scope_denied", "this command is not available remotely");
      const clientId = header(req, HEADER_STREAM) ?? deviceId;
      const ctx = this.o.context(caller.device, clientId);
      const run = async () => this.o.call(ctx, method, args);
      let result: unknown;
      if (methodMutates(method as HostMethod)) {
        const key = header(req, HEADER_IDEMPOTENCY);
        if (!key || key.length > 128) throw new HostError("bad_request", "Idempotency-Key header required");
        result = await this.o.cache.run(deviceId, `${method}\n${key}`, header(req, HEADER_BOOT), text, run);
      } else {
        result = await run();
      }
      this.json(res, 200, result ?? null);
    } catch (error) {
      status = error instanceof HostError ? error.status : 500;
      throw error;
    } finally {
      this.o.log?.(`remote ${deviceId} ${method} ${status}`);
    }
  }

  private subscribe(caller: Caller, body: any) {
    const stream = this.streams.get(String(body?.stream ?? ""));
    if (!stream || stream.device !== caller.device.id) throw new HostError("not_found", "unknown stream");
    const chats: unknown = body?.chats;
    if (!Array.isArray(chats) || chats.length > 64 || chats.some((c) => typeof c !== "string" || !CHAT_HANDLE.test(c))) throw new HostError("bad_request", "chats must be a list of chat handles");
    stream.sub.setTopics(["global", ...(chats as string[]).map((c): Topic => `chat:${c}`)]);
    return { ok: true };
  }

  // ── SSE ────────────────────────────────────────────────────────────────────

  private events(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller) {
    const id = url.searchParams.get("stream") ?? "";
    if (!STREAM_ID.test(id)) throw new HostError("bad_request", "stream id required");
    const chats = (url.searchParams.get("chats") ?? "").split(",").filter(Boolean);
    if (chats.some((c) => !CHAT_HANDLE.test(c))) throw new HostError("bad_request", "invalid chat handle");
    const existing = this.streams.get(id);
    if (existing) this.closeStream(existing, "replaced");

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ bootId: this.o.hub.bootId, seq: this.o.hub.latest, buildId: this.o.buildId })}\n\n`);

    const cap = this.o.streamCap ?? STREAM_CAP_BYTES;
    const stream: Stream = {
      id,
      device: caller.device.id,
      res,
      paused: false,
      heartbeat: setInterval(() => {
        if (!stream.paused) res.write(": hb\n\n");
      }, this.o.heartbeatMs ?? HEARTBEAT_MS),
      sub: undefined as unknown as Subscription,
    };
    // Replay and subscribe in one tick, so no event falls between them.
    const last = parseEventId(header(req, "last-event-id"));
    const since = this.o.hub.since(last?.bootId ?? null, last?.seq ?? null);
    stream.sub = this.o.hub.subscribe({
      topics: ["global", ...chats.map((c): Topic => `chat:${c}`)],
      deliver: (batch) => this.deliver(stream, batch, cap),
      onClose: () => this.cleanup(stream),
    });
    this.streams.set(id, stream);
    this.o.onStream?.("open", id, stream.device);
    if (since.kind === "resync") res.write(`event: resync\ndata: ${JSON.stringify({ reason: since.reason })}\n\n`);
    else this.deliver(stream, since.events.filter((e) => e.topic === "global" || chats.includes(e.topic.slice(5))), cap);

    req.on("close", () => stream.sub.close("client_closed"));
    res.on("drain", () => this.drained(stream));
  }

  private deliver(stream: Stream, batch: HubEnvelope[], cap: number) {
    if (stream.paused) return;
    for (const e of batch) stream.res.write(`id: ${e.bootId}:${e.seq}\nevent: host\ndata: ${JSON.stringify(e)}\n\n`);
    if (stream.res.writableLength > cap) {
      stream.paused = true;
      stream.hardTimer = setTimeout(() => {
        if (stream.res.writableLength > (this.o.streamHardCap ?? STREAM_HARD_CAP_BYTES)) this.closeStream(stream, "backpressure");
      }, this.o.streamHardMs ?? STREAM_HARD_MS);
    }
  }

  private drained(stream: Stream) {
    if (!stream.paused) return;
    stream.paused = false;
    clearTimeout(stream.hardTimer);
    // Events were dropped while paused: the client must replace its state from snapshots.
    stream.res.write(`event: resync\ndata: ${JSON.stringify({ reason: "backpressure" })}\n\n`);
  }

  private closeStream(stream: Stream, reason: string) {
    stream.sub.close(reason);
    stream.res.end();
  }

  private cleanup(stream: Stream) {
    clearInterval(stream.heartbeat);
    clearTimeout(stream.hardTimer);
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
    this.o.onStream?.("close", stream.id, stream.device);
    if (!stream.res.writableEnded) stream.res.end();
  }

  // ── Static ─────────────────────────────────────────────────────────────────

  private async serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HostError("bad_request", "method not allowed");
    const root = this.o.staticDir;
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      throw new HostError("bad_request", "bad path");
    }
    if (rel.includes("\0")) throw new HostError("bad_request", "bad path");
    const file = normalize(join(root ?? "/nonexistent", rel === "/" ? "index.html" : rel));
    let target: string | undefined;
    if (root && (file === root || file.startsWith(root + sep))) {
      const found = await stat(file).catch(() => undefined);
      if (found?.isFile()) target = file;
    }
    // Unknown paths without an extension are app routes: the shell answers.
    if (!target && root && !extname(rel)) {
      const index = join(root, "index.html");
      if ((await stat(index).catch(() => undefined))?.isFile()) target = index;
    }
    const base: Record<string, string> = { "Content-Security-Policy": REMOTE_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    if (!target) {
      if (root && extname(rel)) throw new HostError("not_found", "not found");
      const body = Buffer.from(PLACEHOLDER);
      res.writeHead(200, { ...base, "Content-Type": MIME[".html"]!, "Content-Length": body.length, "Cache-Control": "no-cache" });
      return void res.end(req.method === "HEAD" ? undefined : body);
    }
    const data = await readFile(target);
    const hashed = target.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      ...base,
      "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }
}
