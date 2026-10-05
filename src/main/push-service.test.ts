import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AttentionSummary } from "../shared/host-api";
import { PushService } from "./push-service";
import type { PushRequest } from "./web-push";

const chat = (over: Partial<AttentionSummary> = {}): AttentionSummary => ({ handle: "h1", cwd: "/p", title: "secret title", attention: "running", running: true, dialogs: 0, ...over });
const keyPair = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: "https://push.example.com/abc", p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
};

function setup(options: { viewing?: boolean; status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pigna-push-"));
  const sent: PushRequest[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let viewing = options.viewing ?? false;
  const service = new PushService(join(dir, "push.json"), {
    viewing: () => viewing,
    transport: async (req) => (sent.push(req), { status: options.status ?? 201 }),
    now: () => 1000,
    setTimer: (fn, ms) => timers.push({ fn, ms, live: true }) - 1,
    clearTimer: (id) => void (timers[id as number]!.live = false),
  });
  service.vapidKey();
  service.subscribe("devA", keyPair());
  const fire = async () => {
    for (const t of timers.filter((x) => x.live)) {
      t.live = false;
      t.fn();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { service, sent, timers, fire, dir, setViewing: (v: boolean) => (viewing = v) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PushService", () => {
  it("keeps the VAPID private key in a 0600 file and never returns it", () => {
    const { service, dir } = setup();
    const file = join(dir, "push.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(service.vapidKey())).not.toContain(JSON.parse(readFileSync(file, "utf8")).vapid.privateJwk.d);
    expect(new PushService(file, { viewing: () => false }).vapidKey()).toBe(service.vapidKey());
  });

  it("pushes a run that ended unread, with no text in the request", async () => {
    const { service, sent } = setup();
    service.onGlobal({ kind: "attention", chats: [chat()], removed: [] });
    service.onGlobal({ kind: "attention", chats: [chat({ running: false, attention: "unread", settled: { outcome: "done", at: 9 } })], removed: [] });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.Urgency).toBe("normal");
    expect(Buffer.from(JSON.stringify(sent[0]!.headers)).includes("secret title")).toBe(false);
  });

  it("stays silent when a client was viewing (the chat settles as idle)", async () => {
    const { service, sent } = setup();
    service.onGlobal({ kind: "attention", chats: [chat()], removed: [] });
    service.onGlobal({ kind: "attention", chats: [chat({ running: false, attention: "idle", settled: { outcome: "done", at: 9 } })], removed: [] });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("waits out the approval grace and cancels when the dialog is answered", async () => {
    const a = setup();
    a.service.onGlobal({ kind: "attention", chats: [chat({ dialogs: 1, attention: "waiting" })], removed: [] });
    expect(a.timers[0]!.ms).toBe(10_000);
    a.service.onGlobal({ kind: "attention", chats: [chat({ dialogs: 0 })], removed: [] });
    await a.fire();
    expect(a.sent).toHaveLength(0);

    const b = setup();
    b.service.onGlobal({ kind: "attention", chats: [chat({ dialogs: 1, attention: "waiting" })], removed: [] });
    await b.fire();
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]!.headers.Urgency).toBe("high");

    const c = setup({ viewing: true });
    c.service.onGlobal({ kind: "attention", chats: [chat({ dialogs: 1, attention: "waiting" })], removed: [] });
    await c.fire();
    expect(c.sent).toHaveLength(0);
  });

  it("notifies on a stopped or finished plan, once per note", async () => {
    const { service, sent } = setup();
    const runners = (level: "info" | "error", text: string, at: number) => ({ kind: "atp.runners", runners: {}, notes: { "/p/x.atp.json": { level, text, at } }, orchestrators: {} });
    service.onGlobal(runners("info", "Committed abc", 1));
    service.onGlobal(runners("error", "Stopped: T1 failed", 2));
    service.onGlobal(runners("error", "Stopped: T1 failed", 2));
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("respects per-device prefs and quit", async () => {
    const { service, sent } = setup();
    service.setPrefs("devA", { host_quit: false });
    await service.notifyQuit();
    expect(sent).toHaveLength(0);
    service.setPrefs("devA", { host_quit: true });
    await service.notifyQuit();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.TTL).toBe("600");
  });

  it("removes a subscription on revoke and on 410", async () => {
    const a = setup();
    a.service.keepDevices([]);
    expect(a.service.state("devA").subscribed).toBe(false);
    await a.service.notifyQuit();
    expect(a.sent).toHaveLength(0);

    const b = setup({ status: 410 });
    await b.service.notifyQuit();
    expect(b.service.state("devA").subscribed).toBe(false);
  });

  it("refuses unsafe or malformed subscriptions", () => {
    const { service } = setup();
    expect(() => service.subscribe("d", { ...keyPair(), endpoint: "https://127.0.0.1/x" })).toThrow();
    expect(() => service.subscribe("d", { ...keyPair(), p256dh: "short" })).toThrow();
  });
});
