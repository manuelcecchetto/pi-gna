// Web Push delivery (docs/REMOTE.md section 13a): the VAPID key and the per-device subscriptions in one 0600 file,
// the triggers from attention summaries, dialogs and the ATP runner, suppression while a client views the chat, and the
// send with rate limits. What leaves the host is `{v, kind, chat, t}` plus, for chat pushes, the chat title and a response excerpt.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { admitPush, APPROVAL_GRACE_MS, attentionTrigger, clipText, deliveryOf, newLedger, parsePrefs, PUSH_TITLE_MAX, type PushKind, type PushLedger, type PushPayload, type PushPrefs, DEFAULT_PUSH_PREFS } from "../shared/push-rules";
import type { AttentionSummary, GlobalEvent } from "../shared/host-api";
import { log } from "./log";
import { buildPushRequest, endpointAllowed, generateVapidKeys, httpsTransport, sendPush, topicOf, type PushTransport, type VapidKeys } from "./web-push";

export interface Subscription {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: PushPrefs;
  createdAt: number;
}

interface PushFile {
  vapid?: VapidKeys;
  subscriptions: Subscription[];
}

export interface PushDeps {
  /** True while any client is looking at the chat (a lease with `viewing`). */
  viewing(handle: string): boolean;
  /** The start of the chat's last reply, for the notification body. */
  preview?(handle: string): string | undefined;
  transport?: PushTransport;
  now?: () => number;
  /** The `sub` claim: visible to the push service, so non-identifying by default. */
  subject?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

// Apple answers 403 BadJwtToken to a `sub` it cannot accept (e.g. an `.invalid` domain), so this must look like a real address.
const DEFAULT_SUBJECT = "mailto:pi-gna@example.com";

export class PushService {
  private data: PushFile;
  private readonly ledgers = new Map<string, PushLedger>();
  private readonly inflight = new Set<string>();
  private readonly attention = new Map<string, AttentionSummary>();
  private readonly pending = new Map<string, unknown>();
  private readonly notes = new Map<string, number>();
  private readonly transport: PushTransport;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly file: string, private readonly deps: PushDeps) {
    this.transport = deps.transport ?? httpsTransport;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.data = this.load();
  }

  private load(): PushFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PushFile>;
      const subscriptions = (raw.subscriptions ?? []).filter((s): s is Subscription => typeof s?.deviceId === "string" && typeof s.endpoint === "string" && typeof s.p256dh === "string" && typeof s.auth === "string").map((s) => ({ ...s, prefs: parsePrefs(s.prefs) }));
      return { vapid: raw.vapid?.publicKey && raw.vapid.privateJwk?.d ? raw.vapid : undefined, subscriptions };
    } catch {
      return { subscriptions: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The key a phone subscribes with; made on first use. The private half is never returned. */
  vapidKey(): string {
    if (!this.data.vapid) {
      this.data.vapid = generateVapidKeys();
      this.save();
    }
    return this.data.vapid.publicKey;
  }

  /** What the device has: whether it is subscribed, and its preferences. */
  state(deviceId: string): { subscribed: boolean; prefs: PushPrefs } {
    const sub = this.data.subscriptions.find((s) => s.deviceId === deviceId);
    return { subscribed: !!sub, prefs: sub?.prefs ?? DEFAULT_PUSH_PREFS };
  }

  subscribe(deviceId: string, raw: { endpoint: unknown; p256dh: unknown; auth: unknown }): void {
    const { endpoint, p256dh, auth } = raw;
    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string" || !endpointAllowed(endpoint)) throw new Error("invalid push subscription");
    if (!/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) throw new Error("invalid push subscription keys");
    const previous = this.data.subscriptions.find((s) => s.deviceId === deviceId);
    this.data.subscriptions = [...this.data.subscriptions.filter((s) => s.deviceId !== deviceId), { deviceId, endpoint, p256dh, auth, prefs: previous?.prefs ?? DEFAULT_PUSH_PREFS, createdAt: this.now() }];
    this.save();
  }

  unsubscribe(deviceId: string): void {
    this.remove((s) => s.deviceId === deviceId);
  }

  setPrefs(deviceId: string, prefs: unknown): PushPrefs {
    const sub = this.data.subscriptions.find((s) => s.deviceId === deviceId);
    if (!sub) throw new Error("this device is not subscribed to notifications");
    sub.prefs = parsePrefs({ ...sub.prefs, ...(prefs as object) });
    this.save();
    return sub.prefs;
  }

  /** A device was revoked, or the device list changed: subscriptions of devices that no longer exist go. */
  keepDevices(ids: Iterable<string>): void {
    const keep = new Set(ids);
    this.remove((s) => !keep.has(s.deviceId));
  }

  private remove(match: (s: Subscription) => boolean): void {
    const before = this.data.subscriptions.length;
    for (const s of this.data.subscriptions.filter(match)) this.ledgers.delete(s.deviceId);
    this.data.subscriptions = this.data.subscriptions.filter((s) => !match(s));
    if (this.data.subscriptions.length !== before) this.save();
  }

  // ── Triggers ─────────────────────────────────────────────────────────────────

  /** Feed every global event; only attention summaries and ATP runner notes matter. */
  onGlobal(event: GlobalEvent | { kind: string }): void {
    if (event.kind === "attention") {
      const { chats, removed } = event as Extract<GlobalEvent, { kind: "attention" }>;
      for (const handle of removed) this.forget(handle);
      for (const summary of chats) this.onAttention(summary);
    } else if (event.kind === "atp.runners") {
      const { notes } = event as Extract<GlobalEvent, { kind: "atp.runners" }>;
      for (const [plan, note] of Object.entries(notes)) {
        if (this.notes.get(plan) === note.at) continue;
        this.notes.set(plan, note.at);
        // Runner notes live in memory, so each one is new. A stop is an error note; completion is the "Finished" note.
        if (note.level === "error" || note.text.startsWith("Finished")) void this.send("plan");
      }
    }
  }

  private onAttention(next: AttentionSummary): void {
    const prev = this.attention.get(next.handle);
    this.attention.set(next.handle, next);
    const trigger = attentionTrigger(prev, next);
    if (!trigger) return;
    if (trigger.type === "approval_cleared") return this.forget(next.handle, true);
    if (trigger.type === "ended") return void this.send(trigger.kind, next.handle);
    if (this.pending.has(next.handle)) return;
    // Grace: a desktop answer within it cancels the push.
    this.pending.set(next.handle, this.setTimer(() => {
      this.pending.delete(next.handle);
      const now = this.attention.get(next.handle);
      if (now && now.dialogs > 0 && !this.deps.viewing(next.handle)) void this.send("approval", next.handle);
    }, APPROVAL_GRACE_MS));
  }

  private forget(handle: string, keepSummary = false): void {
    const timer = this.pending.get(handle);
    if (timer !== undefined) this.clearTimer(timer);
    this.pending.delete(handle);
    if (!keepSummary) this.attention.delete(handle);
  }

  /** Best effort, from the quit path: the host is going away. */
  notifyQuit(): Promise<void> {
    return this.send("host_quit");
  }

  // ── Sending ──────────────────────────────────────────────────────────────────

  private async send(kind: PushKind, chat?: string): Promise<void> {
    if (!this.data.vapid || this.data.subscriptions.length === 0) return;
    const vapid = this.data.vapid;
    const now = this.now();
    const title = chat ? clipText(this.attention.get(chat)?.title ?? "", PUSH_TITLE_MAX) : undefined;
    const preview = chat && kind === "done" ? this.deps.preview?.(chat) : undefined;
    const payload: PushPayload = { v: 1, kind, ...(chat ? { chat } : {}), t: now, ...(title ? { title } : {}), ...(preview ? { preview } : {}) };
    const delivery = deliveryOf(kind);
    await Promise.all(this.data.subscriptions.map(async (sub) => {
      const ledger = this.ledgers.get(sub.deviceId) ?? newLedger();
      this.ledgers.set(sub.deviceId, ledger);
      if (this.inflight.has(sub.deviceId) || !admitPush(ledger, sub.prefs, kind, chat, now)) return;
      this.inflight.add(sub.deviceId);
      try {
        const request = buildPushRequest(vapid, this.deps.subject ?? DEFAULT_SUBJECT, sub, payload, { ...delivery, topic: topicOf(chat ?? "", kind) }, now);
        const result = await sendPush(this.transport, request);
        log.info("push", `${sub.deviceId} ${kind} ${result.status}`);
        if (!result.ok && result.gone) this.remove((s) => s.deviceId === sub.deviceId && s.endpoint === sub.endpoint);
      } finally {
        this.inflight.delete(sub.deviceId);
      }
    }));
  }
}
