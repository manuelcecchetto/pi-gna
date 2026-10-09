// Remote authentication core: the paired devices (userData/remote-devices.json) and the pairing flow of
// docs/REMOTE.md section 11. Tokens are 32 random bytes handed out once; only their sha256 is stored and compared
// (constant time). Pairing state lives in memory: a restart drops the code and any pending request. No server here:
// the remote server calls claim/waitFor/authenticate, the desktop calls startPairing/decide.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type DeviceInfo,
  PAIRING_APPROVAL_TIMEOUT_MS,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  type PairingStatus,
} from "../shared/host-api";
import { applyDeviceOp, cleanDeviceName, type DeviceOp, type Devices, deviceInfo, emptyDevices, parseDevices } from "../shared/devices";
import { JsonStore } from "./store";

/** No 0/O, 1/I/L, U/V: a code read off a screen and typed on a phone. */
export const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";

/** `lastSeenAt` is written at most this often per device. */
const SEEN_THROTTLE_MS = 60_000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function newPairingCode(random: (size: number) => Buffer = randomBytes): string {
  // Reject bytes past the largest multiple of the alphabet size, so every character is equally likely.
  const limit = 256 - (256 % PAIRING_ALPHABET.length);
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of random(PAIRING_CODE_LENGTH * 2)) {
      if (byte < limit && code.length < PAIRING_CODE_LENGTH) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
    }
  }
  return code;
}

export interface PairingClaim {
  deviceName: string;
  userAgent: string;
  tailnetLogin: string;
}

/** What a claim or a wait returns to the phone; `token` is present exactly once, on the first read after approval. */
export type PairingResult =
  | { state: "pending_approval" | "denied" | "expired" }
  | { state: "approved"; token: string; device: DeviceInfo };

export type ClaimResult = { ok: true; request: string } | { ok: false; reason: "invalid" | "locked" };

interface Pending extends PairingClaim {
  id: string;
  expiresAt: number;
  outcome?: "denied" | { token: string; device: DeviceInfo };
}

export interface DeviceStoreOptions {
  now?: () => number;
  random?: (size: number) => Buffer;
}

export class DeviceStore {
  private readonly store: JsonStore<Devices, DeviceOp>;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private code?: { value: string; expiresAt: number; attempts: number; locked: boolean };
  private readonly pending = new Map<string, Pending>();
  private signature = "";

  /**
   * @param changed gets the device list (no hashes) whenever devices are added, removed or renamed, so the server can
   *   close streams of revoked ones; `lastSeenAt` updates alone do not call it.
   * @param pairingChanged the pairing status changed (code issued, request arrived, decided).
   */
  constructor(
    file: string,
    private readonly changed: (devices: DeviceInfo[]) => void,
    private readonly pairingChanged: (status: PairingStatus) => void = () => undefined,
    options: DeviceStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    const parse = (raw: unknown) => parseDevices(raw);
    this.store = new JsonStore(file, { name: "devices", item: "device", empty: emptyDevices, apply: (value, op) => applyDeviceOp(value, op), parse, saveMs: 0 }, (value) => this.publish(value));
  }

  private publish({ devices }: Devices) {
    const signature = devices.map((device) => `${device.id}\n${device.name}`).join("\n\n");
    if (signature === this.signature) return;
    this.signature = signature;
    this.changed(devices.map(deviceInfo));
  }

  async list(currentId?: string): Promise<DeviceInfo[]> {
    return (await this.store.get()).devices.map((device) => ({ ...deviceInfo(device), ...(device.id === currentId ? { current: true } : {}) }));
  }

  flushed() {
    return this.store.flushed();
  }

  // ── Pairing ────────────────────────────────────────────────────────────────

  /** A fresh one-time code for the Mac to show; replaces any earlier code and drops requests still waiting. */
  startPairing(): PairingStatus {
    this.code = { value: newPairingCode(this.random), expiresAt: this.now() + PAIRING_CODE_TTL_MS, attempts: 0, locked: false };
    this.pending.clear();
    return this.announce();
  }

  /** The current state for the Mac (with the code while it can be claimed). */
  pairingStatus(): PairingStatus {
    this.expire();
    return this.status();
  }

  /**
   * A phone presents the code. A right code is used up at once and becomes a request awaiting the Mac's decision;
   * wrong ones count against the code, which dies after PAIRING_MAX_ATTEMPTS. The reason never says why it was
   * invalid (wrong, expired, used up).
   */
  claim(code: string, claim: PairingClaim): ClaimResult {
    this.expire();
    const issued = this.code;
    if (!issued) return { ok: false, reason: "invalid" };
    if (issued.locked) return { ok: false, reason: "locked" };
    const given = Buffer.from(String(code ?? "").trim().toUpperCase());
    const want = Buffer.from(issued.value);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      if (++issued.attempts >= PAIRING_MAX_ATTEMPTS) {
        issued.locked = true;
        this.announce();
        return { ok: false, reason: "locked" };
      }
      return { ok: false, reason: "invalid" };
    }
    this.code = undefined;
    const id = randomUUID();
    this.pending.set(id, {
      id,
      deviceName: cleanDeviceName(claim.deviceName),
      userAgent: String(claim.userAgent ?? "").slice(0, 300),
      tailnetLogin: String(claim.tailnetLogin ?? "").slice(0, 200),
      expiresAt: this.now() + PAIRING_APPROVAL_TIMEOUT_MS,
    });
    this.announce();
    return { ok: true, request: id };
  }

  /** The Mac's answer. Allow stores the device and keeps its token for the phone's next `waitFor`. */
  async decide(request: string, allow: boolean): Promise<PairingStatus> {
    this.expire();
    const pending = this.pending.get(request);
    if (!pending || pending.outcome) return this.pairingStatus();
    if (!allow) {
      pending.outcome = "denied";
    } else {
      const token = randomBytes(32).toString("base64url");
      const at = this.now();
      const device = { id: randomUUID(), name: pending.deviceName, userAgent: pending.userAgent, tailnetLogin: pending.tailnetLogin, createdAt: at, lastSeenAt: at, scope: "full" as const };
      await this.store.apply({ type: "add", device: { ...device, tokenHash: hashToken(token) } });
      pending.outcome = { token, device };
    }
    pending.expiresAt = this.now() + PAIRING_APPROVAL_TIMEOUT_MS;
    return this.announce();
  }

  /**
   * The phone's view of its request. The approved token is returned once; later calls (and unknown ids) say `expired`.
   * The server long-polls this.
   */
  waitFor(request: string): PairingResult {
    this.expire();
    const pending = this.pending.get(request);
    if (!pending) return { state: "expired" };
    if (!pending.outcome) return { state: "pending_approval" };
    this.pending.delete(request);
    this.announce();
    return pending.outcome === "denied" ? { state: "denied" } : { state: "approved", ...pending.outcome };
  }

  private expire() {
    const now = this.now();
    let changed = false;
    if (this.code && !this.code.locked && this.code.expiresAt <= now) (this.code = undefined), (changed = true);
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt > now) continue;
      this.pending.delete(id);
      changed = true;
    }
    if (changed) this.announce();
  }

  private announce(): PairingStatus {
    const status = this.status();
    this.pairingChanged(status);
    return status;
  }

  private status(): PairingStatus {
    const request = [...this.pending.values()].find((pending) => !pending.outcome);
    if (request) return { state: "pending_approval", request: { id: request.id, deviceName: request.deviceName, userAgent: request.userAgent, tailnetLogin: request.tailnetLogin } };
    if (this.code?.locked) return { state: "locked" };
    if (this.code) return { state: "code_issued", code: this.code.value, expiresAt: this.code.expiresAt };
    return { state: "idle" };
  }

  // ── Devices ────────────────────────────────────────────────────────────────

  /**
   * The device a token belongs to, or null. A device with a recorded Tailscale login only accepts that login
   * (defense in depth, REMOTE.md s.11). Updates `lastSeenAt` at most once a minute.
   */
  async authenticate(token: string | undefined, tailnetLogin: string | undefined): Promise<DeviceInfo | null> {
    if (!token) return null;
    const hash = hashToken(token);
    const { devices } = await this.store.get();
    // Compare against every record, so timing does not say which one matched.
    let found: (typeof devices)[number] | undefined;
    for (const device of devices) if (sameHash(device.tokenHash, hash)) found = device;
    if (!found || (found.tailnetLogin && found.tailnetLogin !== tailnetLogin)) return null;
    const at = this.now();
    if (at - found.lastSeenAt >= SEEN_THROTTLE_MS) {
      await this.store.apply({ type: "seen", id: found.id, at });
      found = { ...found, lastSeenAt: at };
    }
    return deviceInfo(found);
  }

  async rename(id: string, name: string): Promise<DeviceInfo[]> {
    await this.store.apply({ type: "rename", id, name });
    return this.list();
  }

  async revoke(id: string): Promise<DeviceInfo[]> {
    await this.store.apply({ type: "remove", id });
    return this.list();
  }

  async revokeAll(): Promise<DeviceInfo[]> {
    await this.store.apply({ type: "removeAll" });
    return [];
  }
}
