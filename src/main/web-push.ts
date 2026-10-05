// Web Push on node:crypto only (docs/REMOTE.md section 13a): RFC 8291 message encryption (aes128gcm coding of RFC 8188),
// RFC 8292 VAPID JWTs, and the POST to the push service. Pure apart from `sendPush`, which takes its transport.
import { createCipheriv, createECDH, createHash, generateKeyPairSync, hkdfSync, randomBytes, sign, createPrivateKey } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (the `applicationServerKey` and the `k=` of the header). */
  publicKey: string;
  /** JWK of the private key; never leaves the host. */
  privateJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
}

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The device's public key and auth secret, base64url. */
  p256dh: string;
  auth: string;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const RECORD_SIZE = 4096;

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as VapidKeys["privateJwk"];
  return { publicKey: b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])), privateJwk: jwk };
}

/**
 * The body of one push: `salt | rs | idlen | ephemeral public key | ciphertext` as one record (RFC 8291 section 4).
 * `ephemeral` and `salt` are for the test vector only.
 */
export function encryptPayload(plaintext: Buffer, subscription: Pick<PushSubscriptionKeys, "p256dh" | "auth">, test?: { ephemeralPrivate?: Buffer; salt?: Buffer }): Buffer {
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error("push payload too large");
  const uaPublic = Buffer.from(subscription.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.auth, "base64url");
  const ecdh = createECDH("prime256v1");
  if (test?.ephemeralPrivate) ecdh.setPrivateKey(test.ephemeralPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = test?.salt ?? randomBytes(16);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  // 0x02 closes the only (last) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** `Authorization` value of a VAPID request: ES256 JWT for the push service's origin (RFC 8292). */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, now: number, ttlSeconds = 12 * 3600): string {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + Math.min(ttlSeconds, 24 * 3600), sub: subject };
  const signing = `${b64(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(signing), { key: createPrivateKey({ key: keys.privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${signing}.${b64(signature)}, k=${keys.publicKey}`;
}

export interface PushOptions {
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
  /** Collapses a newer message over an older one still waiting at the service. */
  topic?: string;
}

/** `Topic` must be at most 32 URL-safe characters: a hash, so no chat id leaves the host. */
export const topicOf = (chat: string, kind: string): string => createHash("sha256").update(`${chat}|${kind}`).digest("base64url").slice(0, 32);

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PushResponse {
  status: number;
  retryAfterMs?: number;
}

export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

export function buildPushRequest(keys: VapidKeys, subject: string, subscription: PushSubscriptionKeys, payload: unknown, options: PushOptions, now: number): PushRequest {
  return {
    endpoint: subscription.endpoint,
    headers: {
      Authorization: vapidAuthorization(keys, subscription.endpoint, subject, now),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttl),
      Urgency: options.urgency,
      ...(options.topic ? { Topic: options.topic } : {}),
    },
    body: encryptPayload(Buffer.from(JSON.stringify(payload)), subscription),
  };
}

/** The outcome of one send: delivered, the subscription is gone (404/410), or dropped. */
export type PushResult = { ok: true; status: number } | { ok: false; gone: boolean; status: number };

/** One send with one retry on 429/5xx (honoring Retry-After, at most 5 s). */
export async function sendPush(transport: PushTransport, req: PushRequest, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<PushResult> {
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await transport(req);
      status = response.status;
      if (status >= 200 && status < 300) return { ok: true, status };
      if (status !== 429 && status < 500) break;
      if (attempt === 0) await wait(Math.min(response.retryAfterMs ?? 1000, 5000));
    } catch {
      status = 0;
      break;
    }
  }
  return { ok: false, gone: status === 404 || status === 410, status };
}

/** An endpoint the host may POST to: https, not a literal loopback/private address or a local name. */
export function endpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  return !isIP(host) || publicAddress(host);
}

/** Loopback, link-local, private, unspecified and unique-local addresses are not public. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return publicAddress(lower.slice(7));
  return !(lower === "::" || lower === "::1" || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("fc") || lower.startsWith("fd"));
}

/** node:https POST, 10 s timeout; the connection goes to an address that was checked right before. */
export const httpsTransport: PushTransport = async ({ endpoint, headers, body }) => {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0 || addresses.some((a) => !publicAddress(a.address))) throw new Error("push endpoint resolves to a non-public address");
  }
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, "Content-Length": String(body.length) }, timeout: 10_000 }, (res) => {
      res.resume();
      const retry = Number(res.headers["retry-after"]);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, retryAfterMs: Number.isFinite(retry) ? retry * 1000 : undefined }));
    });
    req.on("timeout", () => req.destroy(new Error("push timeout")));
    req.on("error", reject);
    req.end(body);
  });
};
