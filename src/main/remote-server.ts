// The only network surface for remote clients: plain node:http on 127.0.0.1 (Tailscale serve fronts it), started
// only while remote access is on. Every request is checked in the same order (REMOTE.md s.11): Host, body size,
// device cookie, CSRF headers, Tailscale login. AgentBridge tokens are never looked at here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RemoteImages } from "./remote-images";
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
import { FrameGate, frameParams, parseViewer, type ViewerSpec } from "../shared/browser-view";
import { VISUAL_CSP, visualRemoteAsset } from "./visual-frame";
import type { Frame, ViewHandle } from "./browser/remote-view";
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
/** Frame streams open at once (each costs a screencast and a socket). */
export const VIEW_LIMIT = 6;
const VIEW_BOUNDARY = "pigna-frame";
const TAB_ID = /^[A-Za-z0-9-]{1,64}$/;
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
  /** `resources/visual`: the inline-visual frame document and kit, served at `/visual/<frameId>/` for sandboxed iframes. */
  visualDir?: string;
  /** Audit line, names and statuses only. */
  log?(line: string): void;
  /** A stream opened or closed, so leases can start or end their grace. */
  onStream?(event: "open" | "close", clientId: string, deviceId: string): void;
  /** Starts frames of a browser tab for one viewer (throws on an unknown tab); undefined while the browser is not ready. */
  browserView?(tab: string, viewer: ViewerSpec, onFrame: (frame: Frame) => void): ViewHandle | undefined;
  /** `PUT /api/uploads`: stores the request body for this device (cap enforced while streaming). */
  upload?(device: DeviceInfo, name: string | null, type: string | null, body: IncomingMessage, declared: number | undefined): Promise<unknown>;
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

interface ViewStream {
  device: string;
  res: ServerResponse;
  close(): void;
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
  private readonly views = new Set<ViewStream>();
  private readonly pairHits = new Map<string, number[]>();

  /** Image bytes the phone loads by URL instead of inside JSON. */
  private readonly images = new RemoteImages();

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
    for (const view of [...this.views]) view.close();
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
    for (const view of [...this.views]) if (!live.has(view.device)) view.close();
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

      if (path.startsWith("/visual/")) return await this.serveVisual(req, res, path);
      if (!path.startsWith("/api/")) return await this.serveStatic(req, res, path);
      this.apiHeaders(res);
      const post = req.method === "POST";
      const put = req.method === "PUT";
      if (!post && !put && req.method !== "GET") throw new HostError("bad_request", "method not allowed");
      if (post || put) this.csrf(req, host);
      if (put && path !== "/api/uploads") throw new HostError("bad_request", "method not allowed");

      if (path === "/api/hello" && !post) return this.json(res, 200, await this.hello(req));
      if (path === "/api/pair" && post) return this.json(res, 200, await this.pair(req, await this.body(req)));
      const wait = /^\/api\/pair\/([A-Za-z0-9-]{1,64})\/wait$/.exec(path);
      if (wait && !post) return await this.pairWait(req, res, wait[1]!);

      const caller = await this.authenticate(req);
      if (path === "/api/events" && !post) return this.events(req, res, url, caller);
      if (path === "/api/subscribe" && post) return this.json(res, 200, this.subscribe(caller, await this.body(req)));
      if (put) return await this.putUpload(req, res, url, caller);
      const image = /^\/api\/image\/([a-f0-9]{64})$/.exec(path);
      if (image && !post) return this.serveImage(res, image[1]!);
      const view = /^\/api\/browser\/view\/([A-Za-z0-9-]{1,64})$/.exec(path);
      if (view && !post) return this.browserView(req, res, url, caller, view[1]!);
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

  private json(res: ServerResponse, status: number, value: unknown, extra: Record<string, string | string[]> = {}, images = false) {
    const text = JSON.stringify(value ?? null, images ? this.images.replacer : undefined);
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
      const named = header(req, HEADER_STREAM);
      const clientId = named && STREAM_ID.test(named) ? named : deviceId;
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
      this.json(res, 200, result ?? null, {}, true);
    } catch (error) {
      status = error instanceof HostError ? error.status : 500;
      throw error;
    } finally {
      this.o.log?.(`remote ${deviceId} ${method} ${status}`);
    }
  }

  /** `PUT /api/uploads?name=&type=`: the raw body is the file; the answer is the `UploadResult`. */
  private async putUpload(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller) {
    let status = 200;
    try {
      if (!this.o.upload) throw new HostError("unavailable", "uploads are not available");
      const length = header(req, "content-length");
      const declared = length === undefined ? undefined : Number(length);
      if (declared !== undefined && !(Number.isInteger(declared) && declared >= 0)) throw new HostError("bad_request", "invalid Content-Length");
      const result = await this.o.upload(caller.device, url.searchParams.get("name"), url.searchParams.get("type") ?? header(req, "content-type") ?? null, req, declared);
      this.json(res, 200, result);
    } catch (error) {
      status = error instanceof HostError ? error.status : 500;
      throw error;
    } finally {
      this.o.log?.(`remote ${caller.device.id} uploads.put ${status}`);
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

  /**
   * `GET /api/browser/view/<tab>?w=&h=&dpr=`: JPEG frames as multipart/x-mixed-replace (an `<img>` shows it), each part
   * carrying `X-Css-Width`/`X-Css-Height`, the page size input coordinates are in. Latest-only: while a part is still
   * being written or the viewer's fps cap has not elapsed, newer frames replace the waiting one. The screencast runs only
   * while this response is open.
   */
  private browserView(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller, tab: string) {
    if (!this.o.browserView) throw new HostError("unavailable", "the browser is not available");
    if (!TAB_ID.test(tab)) throw new HostError("bad_request", "invalid tab");
    if (this.views.size >= VIEW_LIMIT) throw new HostError("unavailable", "too many browser streams");
    const viewer = parseViewer(url.searchParams.get("w"), url.searchParams.get("h"), url.searchParams.get("dpr"));
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    // Headers go out once the source accepted the tab (or with its first frame), so an unknown tab still gets a normal error.
    const head = () => {
      if (res.headersSent) return;
      res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${VIEW_BOUNDARY}`, "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
    };
    const gate = new FrameGate<Frame>(async (frame) => {
      if (res.writableEnded || res.destroyed) return;
      head();
      res.write(`--${VIEW_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\nX-Css-Width: ${frame.cssWidth}\r\nX-Css-Height: ${frame.cssHeight}\r\n\r\n`);
      res.write(frame.jpeg);
      res.write("\r\n");
      if (res.writableNeedDrain) await Promise.race([new Promise<void>((resolve) => res.once("drain", resolve)), closed]);
    }, frameParams(viewer).fps);
    let handle: ViewHandle | undefined;
    try {
      handle = this.o.browserView(tab, viewer, (frame) => gate.offer(frame));
    } catch (error) {
      gate.close();
      throw new HostError("not_found", (error as Error).message);
    }
    if (!handle) {
      gate.close();
      throw new HostError("unavailable", "the browser is not ready");
    }
    head();
    const owned = handle;
    const view: ViewStream = {
      device: caller.device.id,
      res,
      close: () => {
        if (!this.views.delete(view)) return;
        gate.close();
        owned.close();
        if (!res.writableEnded) res.end();
      },
    };
    this.views.add(view);
    req.on("close", view.close);
  }

  /** A push for one client only (login progress, which may carry an auth URL): an unsequenced `client` event on the
   * stream `clientId` names, if that stream is open and the device's own. Never goes through the hub, so it is not
   * replayed to anyone else. */
  /** `GET /api/image/<id>`: an image a result or event referred to; immutable, so the phone's cache keeps it. */
  private serveImage(res: ServerResponse, id: string) {
    const image = this.images.get(id);
    if (!image) throw new HostError("not_found", "image not found");
    res.writeHead(200, {
      "Content-Type": image.mimeType,
      "Content-Length": image.bytes.length,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'",
    });
    res.end(image.bytes);
  }

  notify(clientId: string, device: string, event: unknown): boolean {
    const stream = this.streams.get(clientId);
    if (!stream || stream.device !== device || stream.paused) return false;
    stream.res.write(`event: client\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  private deliver(stream: Stream, batch: HubEnvelope[], cap: number) {
    if (stream.paused) return;
    for (const e of batch) stream.res.write(`id: ${e.bootId}:${e.seq}\nevent: host\ndata: ${JSON.stringify(e, this.images.replacer)}\n\n`);
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

  /**
   * Visual frame assets. No credentials: a sandboxed frame has an opaque origin and sends no cookies, and the files are
   * the bundled kit, nothing per user. The frame CSP is the desktop's (no network, forms or navigation).
   */
  private async serveVisual(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HostError("bad_request", "method not allowed");
    const asset = visualRemoteAsset(path);
    if (!asset || !this.o.visualDir) throw new HostError("not_found", "not found");
    const data = await readFile(join(this.o.visualDir, asset.file)).catch(() => undefined);
    if (!data) throw new HostError("not_found", "not found");
    res.writeHead(200, {
      "Content-Type": asset.type,
      "Content-Length": data.length,
      "Content-Security-Policy": VISUAL_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

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
