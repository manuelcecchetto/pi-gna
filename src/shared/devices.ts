// The paired devices on disk (userData/remote-devices.json) as a store model: pure ops, no crypto (main hashes the
// tokens). `tokenHash` is the sha256 of the device's token in hex; the token itself is never stored (REMOTE.md s.11).
import type { DeviceInfo } from "./host-api";

export interface DeviceRecord extends Omit<DeviceInfo, "current"> {
  tokenHash: string;
}

export interface Devices {
  devices: DeviceRecord[];
}

export type DeviceOp =
  | { type: "add"; device: DeviceRecord }
  | { type: "remove"; id: string }
  | { type: "removeAll" }
  | { type: "rename"; id: string; name: string }
  | { type: "seen"; id: string; at: number };

export const MAX_DEVICE_NAME = 60;

export const emptyDevices = (): Devices => ({ devices: [] });

/** A name as shown in the list: trimmed, control characters dropped, capped; `fallback` when nothing is left. */
export function cleanDeviceName(name: unknown, fallback = "Device"): string {
  const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return text.slice(0, MAX_DEVICE_NAME) || fallback;
}

/** The record without its hash, for clients. */
export function deviceInfo({ tokenHash: _hash, ...info }: DeviceRecord): DeviceInfo {
  return info;
}

export function applyDeviceOp(value: Devices, op: DeviceOp): Devices {
  const { devices } = value;
  switch (op.type) {
    case "add":
      if (devices.some((device) => device.id === op.device.id || device.tokenHash === op.device.tokenHash)) throw new Error("Device already exists");
      return { devices: [...devices, op.device] };
    case "remove":
      return devices.some((device) => device.id === op.id) ? { devices: devices.filter((device) => device.id !== op.id) } : value;
    case "removeAll":
      return devices.length ? emptyDevices() : value;
    case "rename": {
      const name = cleanDeviceName(op.name, "");
      if (!name) throw new Error("A device needs a name");
      const device = devices.find((other) => other.id === op.id);
      if (!device) throw new Error(`No device ${op.id}`);
      if (device.name === name) return value;
      return { devices: devices.map((other) => (other === device ? { ...other, name } : other)) };
    }
    case "seen": {
      const device = devices.find((other) => other.id === op.id);
      if (!device || device.lastSeenAt >= op.at) return value;
      return { devices: devices.map((other) => (other === device ? { ...other, lastSeenAt: op.at } : other)) };
    }
  }
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Throws when the file is not an object with a `devices` array; malformed records are dropped and counted. */
export function parseDevices(raw: unknown): { value: Devices; dropped: number } {
  const list = (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) throw new Error("no devices list");
  const devices: DeviceRecord[] = [];
  let dropped = 0;
  for (const item of list) {
    const device = item as Partial<DeviceRecord> | null;
    const valid =
      device &&
      isText(device.id) &&
      device.id &&
      /^[0-9a-f]{64}$/.test(String(device.tokenHash)) &&
      !devices.some((other) => other.id === device.id || other.tokenHash === device.tokenHash);
    if (!valid) {
      dropped++;
      continue;
    }
    const createdAt = isTime(device.createdAt) ? device.createdAt : 0;
    devices.push({
      id: device.id as string,
      name: cleanDeviceName(device.name),
      userAgent: isText(device.userAgent) ? device.userAgent : "",
      tailnetLogin: isText(device.tailnetLogin) ? device.tailnetLogin : "",
      createdAt,
      lastSeenAt: isTime(device.lastSeenAt) ? device.lastSeenAt : createdAt,
      scope: "full",
      tokenHash: device.tokenHash as string,
    });
  }
  return { value: { devices }, dropped };
}
