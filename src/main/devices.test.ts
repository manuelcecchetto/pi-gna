import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyDeviceOp, cleanDeviceName, parseDevices } from "../shared/devices";
import { PAIRING_APPROVAL_TIMEOUT_MS, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS, type DeviceInfo } from "../shared/host-api";
import { DeviceStore, hashToken, newPairingCode, PAIRING_ALPHABET } from "./devices";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const phone = { deviceName: "Phone", userAgent: "Safari", tailnetLogin: "me@example.com" };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pigna-devices-"));
  const file = join(dir, "remote-devices.json");
  const clock = { now: 1_000_000 };
  const lists: DeviceInfo[][] = [];
  const store = new DeviceStore(file, (devices) => lists.push(devices), undefined, { now: () => clock.now });
  /** Pair a device end to end and return its token. */
  const pair = async (claim = phone) => {
    const code = (store.startPairing() as { code: string }).code;
    const result = store.claim(code, claim);
    if (!result.ok) throw new Error("claim failed");
    await store.decide(result.request, true);
    const done = store.waitFor(result.request);
    if (done.state !== "approved") throw new Error("not approved");
    return done;
  };
  return { dir, file, clock, lists, store, pair };
}

describe("pairing codes", () => {
  it("are 8 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = newPairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const char of code) expect(PAIRING_ALPHABET).toContain(char);
    }
    expect(PAIRING_ALPHABET).not.toMatch(/[01OILUV]/);
  });
});

describe("pairing", () => {
  it("needs the Mac's approval, and approval hands out the token exactly once", async () => {
    const { store, pair, lists } = await setup();
    const code = (store.startPairing() as { code: string }).code;
    const claimed = store.claim(code.toLowerCase(), phone);
    expect(claimed).toMatchObject({ ok: true });
    const request = (claimed as { request: string }).request;
    expect(store.waitFor(request)).toEqual({ state: "pending_approval" });
    expect(store.pairingStatus()).toMatchObject({ state: "pending_approval", request: { id: request, deviceName: "Phone", tailnetLogin: "me@example.com" } });
    expect(await store.list()).toEqual([]);
    await store.decide(request, true);
    const done = store.waitFor(request);
    expect(done).toMatchObject({ state: "approved", device: { name: "Phone" } });
    expect(store.waitFor(request)).toEqual({ state: "expired" });
    expect(lists.at(-1)).toHaveLength(1);
    expect(JSON.stringify(lists)).not.toContain("tokenHash");
    expect((await pair()).token).not.toBe((done as { token: string }).token);
  });

  it("a denied request pairs nothing", async () => {
    const { store } = await setup();
    const code = (store.startPairing() as { code: string }).code;
    const request = (store.claim(code, phone) as { request: string }).request;
    await store.decide(request, false);
    expect(store.waitFor(request)).toEqual({ state: "denied" });
    expect(await store.list()).toEqual([]);
    expect(store.pairingStatus()).toEqual({ state: "idle" });
  });

  it("a code is single use", async () => {
    const { store } = await setup();
    const code = (store.startPairing() as { code: string }).code;
    expect(store.claim(code, phone).ok).toBe(true);
    expect(store.claim(code, phone)).toEqual({ ok: false, reason: "invalid" });
  });

  it("a code expires after its TTL", async () => {
    const { store, clock } = await setup();
    const code = (store.startPairing() as { code: string }).code;
    clock.now += PAIRING_CODE_TTL_MS;
    expect(store.pairingStatus()).toEqual({ state: "idle" });
    expect(store.claim(code, phone)).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks the code after five wrong attempts, even for the right code", async () => {
    const { store } = await setup();
    const code = (store.startPairing() as { code: string }).code;
    for (let i = 1; i < PAIRING_MAX_ATTEMPTS; i++) expect(store.claim("WRONGCODE", phone)).toEqual({ ok: false, reason: "invalid" });
    expect(store.claim("WRONGCODE", phone)).toEqual({ ok: false, reason: "locked" });
    expect(store.claim(code, phone)).toEqual({ ok: false, reason: "locked" });
    expect(store.pairingStatus()).toEqual({ state: "locked" });
    expect(store.startPairing().state).toBe("code_issued");
  });

  it("drops a pending request nobody decides, and does not approve it late", async () => {
    const { store, clock } = await setup();
    const code = (store.startPairing() as { code: string }).code;
    const request = (store.claim(code, phone) as { request: string }).request;
    clock.now += PAIRING_APPROVAL_TIMEOUT_MS;
    expect(store.waitFor(request)).toEqual({ state: "expired" });
    await store.decide(request, true);
    expect(await store.list()).toEqual([]);
  });

  it("cleans the device name", () => {
    expect(cleanDeviceName("  My\n phone\u0007 ")).toBe("My phone");
    expect(cleanDeviceName("", "Device")).toBe("Device");
    expect(cleanDeviceName("x".repeat(200))).toHaveLength(60);
  });
});

describe("authentication", () => {
  it("stores only the sha256 of the token", async () => {
    const { store, pair, file } = await setup();
    const { token } = await pair();
    await store.flushed();
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(token);
    expect(JSON.parse(text).devices[0].tokenHash).toBe(hashToken(token));
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("accepts the token with the recorded Tailscale login, rejects others", async () => {
    const { store, pair } = await setup();
    const { token, device } = await pair();
    expect(await store.authenticate(token, "me@example.com")).toMatchObject({ id: device.id });
    expect(await store.authenticate(token, "other@example.com")).toBeNull();
    expect(await store.authenticate(token, undefined)).toBeNull();
    expect(await store.authenticate(`${token}x`, "me@example.com")).toBeNull();
    expect(await store.authenticate(undefined, "me@example.com")).toBeNull();
  });

  it("updates lastSeenAt at most once a minute", async () => {
    const { store, pair, clock } = await setup();
    const { token } = await pair();
    clock.now += 30_000;
    expect((await store.authenticate(token, phone.tailnetLogin))?.lastSeenAt).toBe(1_000_000);
    clock.now += 30_000;
    expect((await store.authenticate(token, phone.tailnetLogin))?.lastSeenAt).toBe(1_060_000);
  });

  it("revoke and revokeAll end access and publish the list", async () => {
    const { store, pair, lists } = await setup();
    const first = await pair();
    const second = await pair({ ...phone, deviceName: "Tablet" });
    expect(lists.at(-1)).toHaveLength(2);
    await store.revoke(first.device.id);
    expect(lists.at(-1)?.map((device) => device.name)).toEqual(["Tablet"]);
    expect(await store.authenticate(first.token, phone.tailnetLogin)).toBeNull();
    expect(await store.authenticate(second.token, phone.tailnetLogin)).not.toBeNull();
    await store.revokeAll();
    expect(lists.at(-1)).toEqual([]);
    expect(await store.authenticate(second.token, phone.tailnetLogin)).toBeNull();
  });

  it("marks the caller's own device and renames", async () => {
    const { store, pair } = await setup();
    const { device } = await pair();
    await store.rename(device.id, " Manuel's iPhone ");
    expect(await store.list(device.id)).toMatchObject([{ name: "Manuel's iPhone", current: true }]);
    await expect(store.rename("nope", "x")).rejects.toThrow();
  });

  it("devices survive a restart", async () => {
    const { store, pair, file } = await setup();
    const { token } = await pair();
    await store.flushed();
    const again = new DeviceStore(file, () => undefined);
    expect(await again.authenticate(token, phone.tailnetLogin)).not.toBeNull();
  });
});

describe("the file", () => {
  it("moves a file that is not a device list aside and starts empty", async () => {
    const { dir, file } = await setup();
    await writeFile(file, "{not json");
    const store = new DeviceStore(file, () => undefined);
    expect(await store.list()).toEqual([]);
    expect((await readdir(dir)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("drops malformed and duplicate records, keeping a copy", async () => {
    const hash = hashToken("a");
    const good = { id: "d1", name: "Phone", userAgent: "", tailnetLogin: "", createdAt: 5, lastSeenAt: 6, scope: "full", tokenHash: hash };
    const { value, dropped } = parseDevices({ devices: [good, { ...good, id: "d2" }, { id: "d3", tokenHash: "short" }, null, { ...good, id: "", tokenHash: hashToken("b") }] });
    expect(value.devices).toEqual([good]);
    expect(dropped).toBe(4);
    expect(() => parseDevices({})).toThrow();
    expect(() => parseDevices(null)).toThrow();
  });

  it("ops reject duplicates and unknown renames", () => {
    const device = { id: "d1", name: "P", userAgent: "", tailnetLogin: "", createdAt: 1, lastSeenAt: 1, scope: "full" as const, tokenHash: hashToken("a") };
    const value = applyDeviceOp({ devices: [] }, { type: "add", device });
    expect(() => applyDeviceOp(value, { type: "add", device })).toThrow();
    expect(applyDeviceOp(value, { type: "remove", id: "zz" })).toBe(value);
  });
});
