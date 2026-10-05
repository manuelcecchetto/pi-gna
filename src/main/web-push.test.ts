import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPushRequest, encryptPayload, endpointAllowed, generateVapidKeys, sendPush, topicOf, vapidAuthorization, type PushRequest } from "./web-push";

const b = (value: string) => Buffer.from(value, "base64url");

describe("encryptPayload", () => {
  // RFC 8291 Appendix A.
  it("matches the RFC 8291 example", () => {
    const body = encryptPayload(Buffer.from("When I grow up, I want to be a watermelon"), { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" }, {
      ephemeralPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      salt: b("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("uses a fresh key and salt per message and refuses an oversized payload", () => {
    const sub = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
    expect(encryptPayload(Buffer.from("x"), sub).equals(encryptPayload(Buffer.from("x"), sub))).toBe(false);
    expect(() => encryptPayload(Buffer.alloc(4000), sub)).toThrow();
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT for the endpoint's origin that verifies with the public key", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(keys, "https://web.push.apple.com/abc/def", "mailto:pigna@example.invalid", 1_700_000_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, p, s, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b(h!).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(b(p!).toString())).toEqual({ aud: "https://web.push.apple.com", exp: 1_700_000_000 + 12 * 3600, sub: "mailto:pigna@example.invalid" });
    expect(b(s!)).toHaveLength(64);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: keys.privateJwk.x, y: keys.privateJwk.y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, b(s!))).toBe(true);
    expect(b(keys.publicKey)).toHaveLength(65);
  });

  it("builds the request headers", () => {
    const keys = generateVapidKeys();
    const sub = { endpoint: "https://fcm.googleapis.com/x", p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
    const req = buildPushRequest(keys, "mailto:a@b.invalid", sub, { v: 1 }, { ttl: 60, urgency: "high", topic: topicOf("chat1", "approval") }, Date.now());
    expect(req.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "60", Urgency: "high" });
    expect(req.headers.Topic).toHaveLength(32);
    expect(req.headers.Topic).not.toContain("chat1");
  });
});

describe("sendPush", () => {
  const req: PushRequest = { endpoint: "https://x.invalid/", headers: {}, body: Buffer.alloc(0) };
  const seq = (...statuses: number[]) => {
    const calls: number[] = [];
    return { calls, transport: async () => ({ status: statuses[calls.push(0) - 1] ?? 500 }) };
  };
  const noWait = async () => undefined;

  it("reports delivery", async () => {
    expect(await sendPush(seq(201).transport, req, noWait)).toEqual({ ok: true, status: 201 });
  });
  it("flags 404 and 410 as gone without retrying", async () => {
    for (const status of [404, 410]) {
      const t = seq(status);
      expect(await sendPush(t.transport, req, noWait)).toEqual({ ok: false, gone: true, status });
      expect(t.calls).toHaveLength(1);
    }
  });
  it("retries once on 429 and 5xx, never on 400/401/403", async () => {
    expect(await sendPush(seq(503, 201).transport, req, noWait)).toEqual({ ok: true, status: 201 });
    const t = seq(429, 429);
    expect(await sendPush(t.transport, req, noWait)).toEqual({ ok: false, gone: false, status: 429 });
    expect(t.calls).toHaveLength(2);
    const u = seq(403, 201);
    expect(await sendPush(u.transport, req, noWait)).toEqual({ ok: false, gone: false, status: 403 });
    expect(u.calls).toHaveLength(1);
  });
  it("drops on a network error", async () => {
    expect(await sendPush(async () => { throw new Error("down"); }, req, noWait)).toEqual({ ok: false, gone: false, status: 0 });
  });
});

describe("endpointAllowed", () => {
  it("takes https push services and refuses local or private targets", () => {
    expect(endpointAllowed("https://web.push.apple.com/abc")).toBe(true);
    expect(endpointAllowed("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    for (const bad of ["http://web.push.apple.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.2/x", "https://169.254.1.1/x", "https://[::1]/x", "https://100.64.1.1/x", "https://u:p@a.example/x", "nope"]) {
      expect(endpointAllowed(bad), bad).toBe(false);
    }
  });
});
