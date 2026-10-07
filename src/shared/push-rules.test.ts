import { describe, expect, it } from "vitest";
import type { AttentionSummary } from "./host-api";
import { admitPush, attentionTrigger, DEFAULT_PUSH_PREFS, newLedger, parsePrefs, PUSH_COOLDOWN_MS, PUSH_HOURLY_LIMIT } from "./push-rules";

const chat = (over: Partial<AttentionSummary> = {}): AttentionSummary => ({ handle: "h", cwd: "/p", title: "t", listed: true, attention: "running", running: true, dialogs: 0, ...over });

describe("attentionTrigger", () => {
  it("schedules an approval when the first dialog appears and clears it when the last goes", () => {
    expect(attentionTrigger(chat(), chat({ dialogs: 1, attention: "waiting" }))).toEqual({ type: "approval_pending" });
    expect(attentionTrigger(chat({ dialogs: 1 }), chat({ dialogs: 2 }))).toBeUndefined();
    expect(attentionTrigger(chat({ dialogs: 1 }), chat({ dialogs: 0 }))).toEqual({ type: "approval_cleared" });
  });
  it("reports a run that ended unread, once per settle", () => {
    const done = chat({ running: false, attention: "unread", settled: { outcome: "done", at: 5 } });
    expect(attentionTrigger(chat(), done)).toEqual({ type: "ended", kind: "done", at: 5 });
    expect(attentionTrigger(done, { ...done })).toBeUndefined();
    expect(attentionTrigger(chat(), chat({ running: false, attention: "failed", settled: { outcome: "error", at: 6 } }))).toEqual({ type: "ended", kind: "failed", at: 6 });
  });
  it("is silent when someone was viewing (the chat is not unread)", () => {
    expect(attentionTrigger(chat(), chat({ running: false, attention: "idle", settled: { outcome: "done", at: 5 } }))).toBeUndefined();
  });
});

describe("admitPush", () => {
  it("honors the per-kind preference", () => {
    expect(admitPush(newLedger(), { ...DEFAULT_PUSH_PREFS, done: false }, "done", "h", 0)).toBe(false);
    expect(admitPush(newLedger(), DEFAULT_PUSH_PREFS, "done", "h", 0)).toBe(true);
  });
  it("allows one push per chat and kind per cooldown", () => {
    const ledger = newLedger();
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "failed", "h", 0)).toBe(true);
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "failed", "h", PUSH_COOLDOWN_MS - 1)).toBe(false);
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "done", "h", 1)).toBe(true);
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "failed", "other", 1)).toBe(true);
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "failed", "h", PUSH_COOLDOWN_MS)).toBe(true);
  });
  it("caps pushes per device per hour", () => {
    const ledger = newLedger();
    for (let i = 0; i < PUSH_HOURLY_LIMIT; i++) expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "done", `c${i}`, i)).toBe(true);
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "done", "extra", 100)).toBe(false);
    expect(admitPush(ledger, DEFAULT_PUSH_PREFS, "done", "extra", 3_600_001 + PUSH_HOURLY_LIMIT)).toBe(true);
  });
});

describe("parsePrefs", () => {
  it("keeps booleans and defaults the rest", () => {
    expect(parsePrefs({ done: false, plan: "x", other: true })).toEqual({ ...DEFAULT_PUSH_PREFS, done: false });
    expect(parsePrefs(null)).toEqual(DEFAULT_PUSH_PREFS);
  });
});

describe("push excerpts", () => {
  it("clips and flattens text", async () => {
    const { clipText, responsePreview } = await import("./push-rules");
    expect(clipText("  a \n\n b  ", 10)).toBe("a b");
    expect(clipText("abcdefghij", 5)).toBe("abcd…");
    expect(clipText("   ", 5)).toBeUndefined();
    const items = [
      { kind: "assistant", message: { content: [{ type: "text", text: "old" }] } },
      { kind: "assistant", message: { content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "Hello\nworld" }, { type: "toolCall" }] } },
      { kind: "notice" },
    ];
    expect(responsePreview(items as never)).toBe("Hello world");
    expect(responsePreview([])).toBeUndefined();
  });
});
