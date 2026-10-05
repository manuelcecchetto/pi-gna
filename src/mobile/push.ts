// Notifications on the phone (docs/REMOTE.md section 13a): whether this page can subscribe, and the subscribe/unsubscribe
// calls. Subscribing needs the installed Home Screen app on iOS and must run inside the tap that asks for permission.
import type { HostClient } from "./client/host-client";

export type PushAvailability = "unsupported" | "needs_install" | "denied" | "ready";

export interface PushEnv {
  hasPush: boolean;
  /** Running as an installed app (iOS standalone, or a display-mode: standalone PWA). */
  standalone: boolean;
  ios: boolean;
  permission: NotificationPermission | "unsupported";
}

export function pushAvailability(env: PushEnv): PushAvailability {
  // Safari tabs on iOS expose no PushManager until the app is on the Home Screen.
  if (env.ios && !env.standalone) return "needs_install";
  if (!env.hasPush || env.permission === "unsupported") return "unsupported";
  return env.permission === "denied" ? "denied" : "ready";
}

export function browserPushEnv(): PushEnv {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return {
    hasPush: "serviceWorker" in navigator && "PushManager" in window,
    standalone: (navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches,
    ios,
    permission: "Notification" in window ? Notification.permission : "unsupported",
  };
}

/** The `applicationServerKey` bytes of a base64url VAPID public key. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const bin = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bin, (char) => char.charCodeAt(0));
}

const b64url = (buffer: ArrayBuffer | null) => (buffer ? btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : "");

/** Call from a tap: asks for permission, subscribes with the host's key and hands the subscription to the host. */
export async function enablePush(client: HostClient): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for pi-gna. Allow them in Settings > Notifications on the iPhone.");
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  // A subscription made with another host key is useless: start over.
  await existing?.unsubscribe();
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await client.call("push.vapidKey", {})) });
  await client.call("push.subscribe", { endpoint: subscription.endpoint, p256dh: b64url(subscription.getKey("p256dh")), auth: b64url(subscription.getKey("auth")) });
}

export async function disablePush(client: HostClient): Promise<void> {
  await client.call("push.unsubscribe", {});
  const registration = await navigator.serviceWorker.ready;
  await (await registration.pushManager.getSubscription())?.unsubscribe();
}

/** The chat handle a deep link names: `#/chat/<handle>`. */
export function chatOfHash(hash: string): string | undefined {
  return /^#\/chat\/([A-Za-z0-9_-]{1,64})$/.exec(hash)?.[1];
}
