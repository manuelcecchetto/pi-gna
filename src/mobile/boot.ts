// Build-id handshake and service worker registration. The host's build id (GET /api/hello) must equal the one this
// bundle was built with; otherwise the shell is stale (an old cached copy after a pi-gna update): drop it and reload.
const RELOAD_KEY = "pigna-build-reload";

export async function helloBuild(): Promise<{ buildId: string; authenticated: boolean } | null> {
  try {
    const response = await fetch("/api/hello", { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** True when the page is reloading because the shell is stale. Guarded so a persistent mismatch cannot loop. */
export async function reloadIfStale(hello: { buildId: string } | null): Promise<boolean> {
  if (!hello || hello.buildId === __PIGNA_BUILD__) {
    sessionStorage.removeItem(RELOAD_KEY);
    return false;
  }
  if (sessionStorage.getItem(RELOAD_KEY) === hello.buildId) return false;
  sessionStorage.setItem(RELOAD_KEY, hello.buildId);
  for (const registration of (await navigator.serviceWorker?.getRegistrations()) ?? []) await registration.unregister();
  for (const key of await caches.keys()) await caches.delete(key);
  location.reload();
  return true;
}

export function registerServiceWorker(): void {
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
