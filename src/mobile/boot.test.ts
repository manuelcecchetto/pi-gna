import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("__PIGNA_BUILD__", "new");
const { reloadIfStale } = await import("./boot");

afterEach(() => vi.unstubAllGlobals());

describe("reloadIfStale", () => {
  it("updates the service worker instead of unregistering it, so the push subscription survives an update", async () => {
    vi.stubGlobal("__PIGNA_BUILD__", "new");
    const registration = { update: vi.fn(async () => undefined), unregister: vi.fn(async () => true) };
    const store = new Map<string, string>();
    const deleted: string[] = [];
    const reload = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistrations: async () => [registration] } });
    vi.stubGlobal("caches", { keys: async () => ["pigna-shell-old"], delete: async (key: string) => void deleted.push(key) });
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal("location", { reload });

    expect(await reloadIfStale({ buildId: "newer" })).toBe(true);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(deleted).toEqual(["pigna-shell-old"]);
    expect(reload).toHaveBeenCalledOnce();
    // A persistent mismatch does not loop.
    expect(await reloadIfStale({ buildId: "newer" })).toBe(false);
  });
});
