// The phone's connection to the host: JSON calls with idempotency keys, one SSE stream with replay and resync,
// and a store holding global state plus a reduced SessionState per chat on screen (docs/REMOTE.md sections 2, 4, 6).
import { createStore, type Store } from "../../renderer/src/lib/store";
import {
  HEADER_BOOT,
  HEADER_CLIENT,
  HEADER_IDEMPOTENCY,
  HostError,
  WATCHDOG_MS,
  methodMutates,
  type AttentionSummary,
  type EventEnvelope,
  type GlobalEvent,
  type HostArgs,
  type HostErrorBody,
  type HostErrorCode,
  type HostEvent,
  type HostMethod,
  type HostResult,
} from "../../shared/host-api";
import { reduceHostEvent, type SessionState } from "../../shared/session-state";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "unreachable" | "unauthorized" | "outdated";

/** Failed reconnects in a row before the UI is told the host is unreachable (it keeps trying meanwhile). */
const UNREACHABLE_AFTER = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const RECONNECT_MAX_MS = 15_000;

// ── Injected environment (real browser by default, fakes in tests) ──────────────

export interface EventSourceLike {
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, listener: (e: { data: string }) => void): void;
  close(): void;
}

export interface Env {
  fetch: typeof fetch;
  EventSource: new (url: string) => EventSourceLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  sleep: (ms: number) => Promise<void>;
  uuid: () => string;
  /** Subscribes to page lifecycle triggers; returns the unsubscribe. */
  onWake: (wake: () => void) => () => void;
}

export function browserEnv(): Env {
  return {
    fetch: (input, init) => fetch(input, init),
    EventSource: EventSource as unknown as Env["EventSource"],
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uuid: () => crypto.randomUUID(),
    onWake(wake) {
      const onVisible = () => document.visibilityState === "visible" && wake();
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("pageshow", wake);
      window.addEventListener("online", wake);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("pageshow", wake);
        window.removeEventListener("online", wake);
      };
    },
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export interface GlobalState {
  projects?: HostResult<"chat.list">;
  attention: Record<string, AttentionSummary>;
  board?: HostResult<"board.get">["value"];
  laments?: HostResult<"laments.get">["value"];
  settings?: HostResult<"settings.get">["value"];
  computer?: HostResult<"computer.get">["value"];
  ui?: HostResult<"ui.get">["value"];
  atp?: HostResult<"atp.state">["value"];
  browser?: HostResult<"browser.state">["value"];
}

export interface ChatEntry {
  /** Absent until the first snapshot arrives. */
  session?: SessionState;
  turns?: { total: number; from: number };
  /** `seq` the session reflects. */
  seq: number;
  error?: string;
}

export interface ClientState {
  connection: ConnectionState;
  bootId?: string;
  /** Highest event `seq` applied from the stream (same `bootId`). */
  lastSeq: number;
  global: GlobalState;
  chats: Record<string, ChatEntry>;
}

type GlobalKey = keyof GlobalState;

/** How each global value is read and how its event replaces it. `seq` is absent for reads that carry none. */
const GLOBAL_READS: { key: GlobalKey; read: (c: HostClient) => Promise<{ seq?: number; value: unknown }> }[] = [
  {
    key: "attention",
    read: async (c) => ({ value: Object.fromEntries((await c.call("chat.live", {})).map((chat) => [chat.handle, chat])) }),
  },
  { key: "projects", read: async (c) => ({ value: await c.call("chat.list", {}) }) },
  { key: "board", read: (c) => c.call("board.get", {}) },
  { key: "laments", read: (c) => c.call("laments.get", {}) },
  { key: "settings", read: (c) => c.call("settings.get", {}) },
  { key: "computer", read: (c) => c.call("computer.get", {}) },
  { key: "ui", read: (c) => c.call("ui.get", {}) },
  { key: "atp", read: (c) => c.call("atp.state", {}) },
  { key: "browser", read: (c) => c.call("browser.state", {}) },
];

/** The `GlobalKey` an event replaces whole, with the new value; null for events the store does not hold. */
function globalPatch(event: GlobalEvent): { key: GlobalKey; value: unknown } | null {
  switch (event.kind) {
    case "projects": return { key: "projects", value: event.projects };
    case "board": return { key: "board", value: event.board };
    case "laments": return { key: "laments", value: event.laments };
    case "settings": return { key: "settings", value: event.settings };
    case "computer": return { key: "computer", value: event.settings };
    case "ui": return { key: "ui", value: event.ui };
    case "browser": return { key: "browser", value: event.state };
    default: return null;
  }
}

function applyGlobal(state: GlobalState, event: GlobalEvent): GlobalState {
  if (event.kind === "attention") {
    const attention = { ...state.attention };
    for (const chat of event.chats) attention[chat.handle] = chat;
    for (const handle of event.removed) delete attention[handle];
    return { ...state, attention };
  }
  if (event.kind === "atp.runners") {
    const { runners, notes, orchestrators } = event;
    return { ...state, atp: { runners, notes, orchestrators, held: state.atp?.held ?? [] } };
  }
  if (event.kind === "atp.held") {
    return state.atp ? { ...state, atp: { ...state.atp, held: event.plans } } : state;
  }
  const patch = globalPatch(event);
  return patch ? { ...state, [patch.key]: patch.value } : state;
}

export interface CallOptions {
  /** Abort a call (the page is leaving the screen). */
  signal?: AbortSignal;
}

export interface HostClientOptions {
  env?: Env;
  /** The build id this bundle was built with; the host's differing one marks the shell outdated. */
  buildId?: string;
  /** Called when the client wants the page reloaded (outdated build). */
  onOutdated?: () => void;
  /** Called when the device is not (or no longer) paired. */
  onUnauthorized?: () => void;
}

/** Sees each chat event once, as it is applied to a chat on screen (not the snapshots a resync replaces it with). */
export type ChatEventListener = (handle: string, event: HostEvent, session: SessionState) => void;

export class HostClient {
  readonly store: Store<ClientState>;
  private readonly chatListeners = new Set<ChatEventListener>();
  /** The SSE stream id, which doubles as the client id for leases and presence. */
  readonly streamId: string;
  private readonly env: Env;
  private source?: EventSourceLike;
  private watchdog: unknown;
  private reconnectTimer: unknown;
  private failures = 0;
  private chatsOnScreen: string[] = [];
  private stopped = true;
  private unwake?: () => void;
  /** Events that arrived while their snapshot was being read, per topic (`global` or `chat:<handle>`). */
  private readonly pending = new Map<string, EventEnvelope[]>();
  private resyncing?: Promise<void>;
  private resyncAgain = false;

  constructor(private readonly o: HostClientOptions = {}) {
    this.env = o.env ?? browserEnv();
    this.streamId = this.env.uuid();
    this.store = createStore<ClientState>({ connection: "connecting", lastSeq: 0, global: { attention: {} }, chats: {} });
  }

  // ── Calls ──────────────────────────────────────────────────────────────────

  /**
   * One host method. Mutating methods carry an `Idempotency-Key` that stays the same across retries; reads and keyed
   * calls retry transient failures with backoff. A `host_restarted` answer is never retried: the host lost the key.
   */
  async call<M extends HostMethod>(method: M, args: HostArgs<M>, options: CallOptions = {}): Promise<HostResult<M>> {
    const keyed = methodMutates(method);
    const key = keyed ? this.env.uuid() : undefined;
    const body = JSON.stringify(args ?? {});
    for (let attempt = 0; ; attempt++) {
      let error: HostError;
      try {
        return (await this.send(method, body, key, options.signal)) as HostResult<M>;
      } catch (e) {
        if (!(e instanceof HostError)) throw e;
        error = e;
      }
      if (error.code === "unauthorized") this.setConnection("unauthorized");
      const transient = error.code === "unavailable" || error.code === "rate_limited" || error.code === "internal";
      if (!transient || attempt >= RETRY_DELAYS_MS.length || options.signal?.aborted) throw error;
      const retryAfter = Number(error.detail?.retryAfter);
      await this.env.sleep(retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt]!);
    }
  }

  private async send(method: string, body: string, key: string | undefined, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json", [HEADER_CLIENT]: "1" };
    const boot = this.store.get().bootId;
    if (boot) headers[HEADER_BOOT] = boot;
    if (key) headers[HEADER_IDEMPOTENCY] = key;
    let response: Response;
    try {
      response = await this.env.fetch(method === "subscribe" ? "/api/subscribe" : `/api/call/${method}`, { method: "POST", headers, body, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new HostError("unavailable", "host unreachable");
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    if (response.ok) return json;
    const err = (json as { error?: Partial<HostErrorBody> } | undefined)?.error;
    // A proxy answering for a host that is down (tailscale serve) has no JSON body.
    const code: HostErrorCode = err?.code ?? (response.status >= 500 ? "unavailable" : "internal");
    throw new HostError(code, err?.message ?? `HTTP ${response.status}`, err?.detail);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unwake = this.env.onWake(() => this.wake());
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.unwake?.();
    this.closeSource();
    this.env.clearTimeout(this.reconnectTimer);
  }

  /** The chats on screen: subscribed on the stream and kept as reduced sessions. */
  async setChats(handles: string[]): Promise<void> {
    const added = handles.filter((h) => !this.chatsOnScreen.includes(h));
    this.chatsOnScreen = [...handles];
    this.store.set((s) => {
      const chats = Object.fromEntries(Object.entries(s.chats).filter(([h]) => handles.includes(h)));
      return { ...s, chats };
    });
    for (const handle of this.chatsOnScreen) if (!handles.includes(handle)) this.pending.delete(`chat:${handle}`);
    if (this.store.get().connection === "live") {
      try {
        await this.send("subscribe", JSON.stringify({ stream: this.streamId, chats: handles }), undefined);
      } catch {
        // The next reconnect carries the set in the URL.
      }
      await Promise.all(added.map((h) => this.loadChat(h)));
    }
  }

  // ── Stream ─────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    this.closeSource();
    this.env.clearTimeout(this.reconnectTimer);
    const query = new URLSearchParams({ stream: this.streamId });
    if (this.chatsOnScreen.length) query.set("chats", this.chatsOnScreen.join(","));
    const source = new this.env.EventSource(`/api/events?${query}`);
    this.source = source;
    this.armWatchdog();
    source.addEventListener("hello", (e) => {
      if (this.source !== source) return;
      this.armWatchdog();
      void this.onHello(JSON.parse(e.data));
    });
    source.addEventListener("host", (e) => {
      if (this.source !== source) return;
      this.armWatchdog();
      this.onEnvelope(JSON.parse(e.data));
    });
    source.addEventListener("resync", () => {
      if (this.source !== source) return;
      this.armWatchdog();
      void this.resync();
    });
    // Heartbeats are comments EventSource never surfaces; an open stream resets the watchdog through any frame, and
    // the server sends `hello` first, so silence for WATCHDOG_MS means the connection is dead.
    source.onerror = () => {
      if (this.source !== source) return;
      // CLOSED: the browser gave up; CONNECTING: it retries itself and sends Last-Event-ID, so the gap replays.
      if (source.readyState === 2) this.scheduleReconnect();
      else this.failed();
    };
  }

  private closeSource(): void {
    this.env.clearTimeout(this.watchdog);
    const source = this.source;
    this.source = undefined;
    source?.close();
  }

  private armWatchdog(): void {
    this.env.clearTimeout(this.watchdog);
    this.watchdog = this.env.setTimeout(() => {
      this.failed();
      this.connect();
    }, WATCHDOG_MS);
  }

  /** "Retry now" on the connection banner: skip the backoff. */
  reconnectNow(): void {
    this.wake();
  }

  /** visibilitychange to visible, pageshow, online: the socket may be dead without telling us. */
  private wake(): void {
    if (this.stopped) return;
    const { connection } = this.store.get();
    if (connection === "unauthorized" || connection === "outdated") return;
    this.connect();
  }

  private scheduleReconnect(): void {
    this.failed();
    this.closeSource();
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** Math.min(this.failures, 4));
    this.env.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.env.setTimeout(() => this.connect(), delay);
  }

  /** Counts a failure and decides what the user sees; asks the host why when the stream cannot say (401, new build). */
  private failed(): void {
    this.failures++;
    const { connection } = this.store.get();
    if (connection === "unauthorized" || connection === "outdated") return;
    this.setConnection(this.failures >= UNREACHABLE_AFTER ? "unreachable" : connection === "connecting" ? "connecting" : "reconnecting");
    void this.probe();
  }

  private async probe(): Promise<void> {
    try {
      const response = await this.env.fetch("/api/hello", { cache: "no-store" });
      if (!response.ok) return;
      const hello = (await response.json()) as { buildId: string; authenticated: boolean };
      if (!hello.authenticated) this.setConnection("unauthorized");
      else if (this.o.buildId && hello.buildId !== this.o.buildId) this.setConnection("outdated");
    } catch {
      // Unreachable: the failure count already says so.
    }
  }

  private setConnection(connection: ConnectionState): void {
    if (this.store.get().connection === connection) return;
    this.store.set((s) => ({ ...s, connection }));
    if (connection === "unauthorized") {
      this.stop();
      this.o.onUnauthorized?.();
    } else if (connection === "outdated") {
      this.stop();
      this.o.onOutdated?.();
    }
  }

  private async onHello(hello: { bootId: string; seq: number; buildId: string }): Promise<void> {
    if (this.o.buildId && hello.buildId !== this.o.buildId) return this.setConnection("outdated");
    this.failures = 0;
    this.setConnection("live");
    const known = this.store.get().bootId;
    // A new boot without a `resync` frame (cannot happen with a correct host) still invalidates every seq we hold.
    if (known !== undefined && known !== hello.bootId) await this.resync(hello.bootId);
    else if (known === undefined) this.store.set((s) => ({ ...s, bootId: hello.bootId }));
    else await this.resubscribe();
  }

  /**
   * The browser retries a dropped EventSource on its own, with the URL it first connected with: a stream opened before
   * a chat was on screen comes back without it (and the replay only covers the topics a stream holds). Subscribe again
   * and read the chats afresh, so a reconnect never leaves a transcript silently stale.
   */
  private async resubscribe(): Promise<void> {
    if (!this.chatsOnScreen.length || this.resyncing) return;
    const handles = [...this.chatsOnScreen];
    for (const handle of handles) this.pending.set(`chat:${handle}`, []);
    try {
      await this.send("subscribe", JSON.stringify({ stream: this.streamId, chats: handles }), undefined);
    } catch {
      // The stream is down again: the next hello does this once more.
    }
    await Promise.all(handles.map((handle) => this.loadChat(handle)));
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private onEnvelope(envelope: EventEnvelope): void {
    const state = this.store.get();
    if (state.bootId !== undefined && envelope.bootId !== state.bootId) {
      void this.resync(envelope.bootId);
      return;
    }
    if (envelope.seq <= state.lastSeq) return; // replayed or duplicate
    this.store.set((s) => ({ ...s, lastSeq: envelope.seq }));
    const buffered = this.pending.get(envelope.topic);
    if (buffered) buffered.push(envelope);
    else this.apply(envelope);
  }

  /** Subscribe to chat events as they apply; `session` is the state before the event. Returns the unsubscribe. */
  onChatEvent(listener: ChatEventListener): () => void {
    this.chatListeners.add(listener);
    return () => void this.chatListeners.delete(listener);
  }

  private apply(envelope: EventEnvelope): void {
    if (envelope.topic === "global") {
      this.store.set((s) => ({ ...s, global: applyGlobal(s.global, envelope.event as GlobalEvent) }));
      return;
    }
    const handle = envelope.topic.slice("chat:".length);
    this.store.set((s) => {
      const entry = s.chats[handle];
      if (!entry?.session || envelope.seq <= entry.seq) return s;
      for (const listener of this.chatListeners) listener(handle, envelope.event as HostEvent, entry.session);
      const session = reduceHostEvent(entry.session, envelope.event as HostEvent, Date.now());
      return { ...s, chats: { ...s.chats, [handle]: { ...entry, session, seq: envelope.seq } } };
    });
  }

  /** Replaces global values and the chats on screen from snapshots; events that arrive meanwhile are applied on top. */
  resync(bootId?: string): Promise<void> {
    if (this.resyncing) {
      this.resyncAgain = true;
      return this.resyncing;
    }
    this.resyncing = (async () => {
      do {
        this.resyncAgain = false;
        await this.doResync(bootId);
        bootId = undefined;
      } while (this.resyncAgain && !this.stopped);
    })().finally(() => {
      this.resyncing = undefined;
    });
    return this.resyncing;
  }

  private async doResync(bootId?: string): Promise<void> {
    // seq counters belong to one boot: after a new boot the old ones would drop every event.
    if (bootId !== undefined) this.store.set((s) => ({ ...s, bootId, lastSeq: 0 }));
    const topics = ["global", ...this.chatsOnScreen.map((h) => `chat:${h}`)];
    for (const topic of topics) this.pending.set(topic, []);
    const base = this.store.get().lastSeq;
    await Promise.all([this.loadGlobal(base), ...this.chatsOnScreen.map((h) => this.loadChat(h, true))]);
  }

  private async loadGlobal(base: number): Promise<void> {
    this.pending.set("global", this.pending.get("global") ?? []);
    const seqs: Partial<Record<GlobalKey, number>> = {};
    const values: Partial<GlobalState> = {};
    await Promise.all(
      GLOBAL_READS.map(async ({ key, read }) => {
        try {
          const result = await read(this);
          (values as Record<string, unknown>)[key] = result.value;
          seqs[key] = result.seq ?? base;
        } catch {
          // Keep the old value for this key; the next resync retries.
        }
      }),
    );
    const buffered = this.pending.get("global") ?? [];
    this.pending.delete("global");
    this.store.set((s) => ({ ...s, global: { ...s.global, ...values } }));
    for (const envelope of buffered) {
      const patch = globalPatch(envelope.event as GlobalEvent);
      // A value read at `seq` already reflects older events for that key.
      if (patch && envelope.seq <= (seqs[patch.key] ?? 0)) continue;
      this.apply(envelope);
    }
  }

  /**
   * Prepends the turns before the ones the chat shows (`turns.from`, the snapshot cursor). Events keep applying to the
   * end of the transcript meanwhile; a resync that replaces the chat drops the older turns again.
   */
  async loadEarlier(handle: string): Promise<void> {
    const entry = this.store.get().chats[handle];
    if (!entry?.session || !entry.turns || entry.turns.from === 0) return;
    const page = await this.call("chat.snapshot", { handle, before: entry.turns.from });
    const older = page.value.state as unknown as SessionState;
    this.store.set((s) => {
      const current = s.chats[handle];
      // A resync or another page landed meanwhile: this one no longer joins the transcript's start.
      if (!current?.session || current.turns?.from !== entry.turns!.from) return s;
      const session = { ...current.session, items: [...older.items, ...current.session.items], tools: { ...older.tools, ...current.session.tools } };
      return { ...s, chats: { ...s.chats, [handle]: { ...current, session, turns: { total: current.turns.total, from: page.value.turns.from } } } };
    });
  }

  private async loadChat(handle: string, replace = false): Promise<void> {
    const topic = `chat:${handle}`;
    if (!this.pending.has(topic)) this.pending.set(topic, []);
    try {
      const snapshot = await this.call("chat.snapshot", { handle });
      this.store.set((s) => ({
        ...s,
        chats: {
          ...s.chats,
          [handle]: { session: snapshot.value.state as unknown as SessionState, turns: snapshot.value.turns, seq: snapshot.seq },
        },
      }));
    } catch (e) {
      this.store.set((s) => ({
        ...s,
        chats: { ...s.chats, [handle]: { ...(replace ? {} : s.chats[handle]), seq: s.chats[handle]?.seq ?? 0, error: (e as Error).message } },
      }));
    }
    const buffered = this.pending.get(topic) ?? [];
    this.pending.delete(topic);
    for (const envelope of buffered) this.apply(envelope); // apply() drops those the snapshot already reflects
  }
}
