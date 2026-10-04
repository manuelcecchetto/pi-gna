import { describe, expect, it } from "vitest";
import { IdempotencyCache, KeyedMutex } from "./command-layer";

describe("IdempotencyCache", () => {
  it("runs a keyed call once: a retry (even in flight) gets the cached result", async () => {
    const cache = new IdempotencyCache("boot1");
    let runs = 0;
    const call = () => cache.run("dev1", "k1", "boot1", "body", async () => ++runs);
    const [a, b] = await Promise.all([call(), call()]);
    expect([a, b, await call()]).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
    expect(await cache.run("dev1", "k2", "boot1", "body", async () => ++runs)).toBe(2);
  });

  it("scopes keys, expires them after ten minutes and does not keep failures", async () => {
    let now = 0;
    const cache = new IdempotencyCache("boot1", () => now);
    let runs = 0;
    await cache.run("a", "k", undefined, "x", async () => ++runs);
    await cache.run("b", "k", undefined, "x", async () => ++runs);
    expect(runs).toBe(2);
    now = 10 * 60_000 + 1;
    await cache.run("a", "k", undefined, "x", async () => ++runs);
    expect(runs).toBe(3);
    await expect(cache.run("a", "bad", undefined, "x", async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await cache.run("a", "bad", undefined, "x", async () => "ok")).toBe("ok");
  });

  it("fails a retry from a previous boot with host_restarted, before running", async () => {
    const cache = new IdempotencyCache("boot2");
    let runs = 0;
    await expect(cache.run("dev1", "k1", "boot1", "x", async () => ++runs)).rejects.toMatchObject({ code: "host_restarted" });
    expect(runs).toBe(0);
  });

  it("refuses a key reused for another body and reports results too large to keep", async () => {
    const cache = new IdempotencyCache("b");
    await cache.run("d", "k", "b", "one", async () => 1);
    await expect(cache.run("d", "k", "b", "two", async () => 2)).rejects.toMatchObject({ code: "bad_request", detail: { reason: "idempotency_mismatch" } });
    await cache.run("d", "big", "b", "x", async () => "x".repeat(300 * 1024));
    await expect(cache.run("d", "big", "b", "x", async () => "y")).rejects.toMatchObject({ code: "conflict", detail: { reason: "result_unavailable" } });
  });
});

describe("KeyedMutex", () => {
  it("runs tasks of a key in order, and survives a failing task", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const task = (name: string, ms: number, fail = false) => async () => {
      order.push(`${name}+`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}-`);
      if (fail) throw new Error(name);
    };
    const results = await Promise.allSettled([mutex.run("c", task("a", 10, true)), mutex.run("c", task("b", 1)), mutex.run("other", task("x", 1))]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(order.indexOf("a-")).toBeLessThan(order.indexOf("b+"));
  });
});
