import { beforeEach, describe, expect, it, vi } from "vitest";

let faviconFor: typeof import("./favicons").faviconFor;

beforeEach(async () => {
  vi.resetModules();
  ({ faviconFor } = await import("./favicons"));
});

describe("faviconFor", () => {
  it("asks the host once per key, also while a request is in flight", async () => {
    const load = vi.fn(async (key: string) => `data:image/png;base64,${key}`);
    const [a, b] = await Promise.all([faviconFor("k1", load), faviconFor("k1", load)]);
    expect(a).toBe("data:image/png;base64,k1");
    expect(b).toBe(a);
    expect(await faviconFor("k1", load)).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
    await faviconFor("k2", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks again after a miss or a failure", async () => {
    const load = vi.fn<(key: string) => Promise<string | null>>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline")).mockResolvedValue("data:image/png;base64,QQ==");
    expect(await faviconFor("k", load)).toBeNull();
    expect(await faviconFor("k", load)).toBeNull();
    expect(await faviconFor("k", load)).toBe("data:image/png;base64,QQ==");
    expect(await faviconFor("k", load)).toBe("data:image/png;base64,QQ==");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps at most 200 icons, dropping the oldest", async () => {
    const load = vi.fn(async (key: string) => `data:,${key}`);
    for (let n = 0; n <= 200; n++) await faviconFor(`k${n}`, load);
    expect(load).toHaveBeenCalledTimes(201);
    await faviconFor("k200", load);
    await faviconFor("k1", load);
    expect(load).toHaveBeenCalledTimes(201);
    await faviconFor("k0", load);
    expect(load).toHaveBeenCalledTimes(202);
  });
});
