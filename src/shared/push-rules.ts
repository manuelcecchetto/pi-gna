// What a push is about and when one is sent (docs/REMOTE.md section 13a): kinds, per-device preferences, the payload,
// and the pure rules for suppression and rate limits. Delivery lives in src/main/push-service.ts.
import type { AttentionSummary } from "./host-api";

export const PUSH_KINDS = ["approval", "done", "failed", "plan", "host_quit"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** What the phone's service worker reads: the kind, an opaque chat handle, the time, and the chat title and a response excerpt when there are any. */
export interface PushPayload {
  v: 1;
  kind: PushKind;
  chat?: string;
  t: number;
  title?: string;
  preview?: string;
}

export const PUSH_TITLE_MAX = 80;
export const PUSH_PREVIEW_MAX = 140;

/** Whitespace collapsed and cut to `max` characters (with an ellipsis); undefined when nothing is left. */
export function clipText(text: string, max: number): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : flat;
}

/** The start of the last assistant reply in a chat's items: its text blocks only, no tool calls or thinking. */
export function responsePreview(items: readonly { kind: string; message?: { content?: readonly { type: string; text?: string }[] } }[]): string | undefined {
  const last = items.findLast((item) => item.kind === "assistant");
  const text = (last?.message?.content ?? []).flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join(" ");
  return clipText(text, PUSH_PREVIEW_MAX);
}

export type PushPrefs = Record<PushKind, boolean>;

export const DEFAULT_PUSH_PREFS: PushPrefs = { approval: true, done: true, failed: true, plan: true, host_quit: true };

/** Notification text per kind, composed on the phone; the host sends no text. */
export const PUSH_TEXT: Record<PushKind, string> = {
  approval: "Approval needed",
  done: "Run finished",
  failed: "Run failed",
  plan: "Plan stopped",
  host_quit: "pi-gna is quitting",
};

/** Approvals a desktop (or any client) answers within this time never ping. */
export const APPROVAL_GRACE_MS = 10_000;
/** At most one push per device, chat and kind in this window, and this many per device per hour. */
export const PUSH_COOLDOWN_MS = 30_000;
export const PUSH_HOURLY_LIMIT = 20;

export function parsePrefs(raw: unknown): PushPrefs {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const prefs = { ...DEFAULT_PUSH_PREFS };
  for (const kind of PUSH_KINDS) if (typeof input[kind] === "boolean") prefs[kind] = input[kind] as boolean;
  return prefs;
}

/** What one attention update means for notifications: an approval to schedule, a run that ended, nothing. */
export type AttentionTrigger = { type: "approval_pending" } | { type: "approval_cleared" } | { type: "ended"; kind: "done" | "failed"; at: number };

export function attentionTrigger(prev: AttentionSummary | undefined, next: AttentionSummary): AttentionTrigger | undefined {
  if (next.dialogs > 0 && !(prev && prev.dialogs > 0)) return { type: "approval_pending" };
  if (next.dialogs === 0 && prev && prev.dialogs > 0) return { type: "approval_cleared" };
  // A new `settled` stamp on a chat nobody was viewing (the host marks only those unread/failed).
  if (next.settled && next.settled.at !== prev?.settled?.at && (next.attention === "unread" || next.attention === "failed")) {
    return { type: "ended", kind: next.settled.outcome === "error" ? "failed" : "done", at: next.settled.at };
  }
  return undefined;
}

/** Sliding record of what one device was sent. */
export interface PushLedger {
  /** `${chat}|${kind}` -> last send time. */
  last: Record<string, number>;
  /** Send times within the last hour. */
  hour: number[];
}

export const newLedger = (): PushLedger => ({ last: {}, hour: [] });

/** Whether a push may go to a device now; records it when allowed. */
export function admitPush(ledger: PushLedger, prefs: PushPrefs, kind: PushKind, chat: string | undefined, now: number): boolean {
  if (!prefs[kind]) return false;
  ledger.hour = ledger.hour.filter((at) => now - at < 3_600_000);
  if (ledger.hour.length >= PUSH_HOURLY_LIMIT) return false;
  const key = `${chat ?? ""}|${kind}`;
  const last = ledger.last[key];
  if (last !== undefined && now - last < PUSH_COOLDOWN_MS) return false;
  ledger.last[key] = now;
  ledger.hour.push(now);
  for (const [k, at] of Object.entries(ledger.last)) if (now - at >= PUSH_COOLDOWN_MS) delete ledger.last[k];
  return true;
}

/** The delivery parameters of a kind (REMOTE.md section 13a). */
export function deliveryOf(kind: PushKind): { ttl: number; urgency: "normal" | "high" } {
  if (kind === "approval") return { ttl: 3600, urgency: "high" };
  if (kind === "host_quit") return { ttl: 600, urgency: "normal" };
  return { ttl: 86_400, urgency: "normal" };
}
