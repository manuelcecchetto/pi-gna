import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBridge } from "./bridge";

describe("AgentBridge start", () => {
  afterEach(() => {
    vi.doUnmock("node:http");
    vi.resetModules();
  });

  it("listens once: a second start (a pi spawn) waits for the same server", async () => {
    const bridge = new AgentBridge();
    const first = bridge.start();
    expect(bridge.start()).toBe(first);
    await first;
    try {
      const url = bridge.url;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await bridge.start();
      expect(bridge.url).toBe(url);
    } finally {
      bridge.stop();
    }
  });

  it("rejects, for every waiter, when it cannot listen", async () => {
    vi.resetModules();
    vi.doMock("node:http", async (original) => ({
      ...(await original<typeof import("node:http")>()),
      createServer: () => Object.assign(new EventEmitter(), { listen(this: EventEmitter) { queueMicrotask(() => this.emit("error", new Error("listen EPERM"))); } }),
    }));
    const { AgentBridge: Fresh } = await import("./bridge");
    const bridge = new Fresh();
    await expect(bridge.start()).rejects.toThrow("listen EPERM");
    await expect(bridge.start()).rejects.toThrow("listen EPERM");
    expect(bridge.url).toBe("");
  });
});

describe("AgentBridge tokens", () => {
  it("a renamed token acts for its new handle, and unregistering that handle ends it", async () => {
    const bridge = new AgentBridge();
    await bridge.start();
    try {
      bridge.route("/who", async (handle) => handle);
      const token = bridge.register("spare1");
      const other = bridge.register("other");
      const who = async (key: string) => {
        const response = await fetch(`${bridge.url}/who`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" });
        return response.ok ? await response.json() : response.status;
      };
      expect(await who(token)).toBe("spare1");
      bridge.rename("spare1", "chat1");
      expect(await who(token)).toBe("chat1");
      expect(await who(other)).toBe("other");
      bridge.unregister("chat1");
      expect(await who(token)).toBe(401);
      expect(await who(other)).toBe("other");
    } finally {
      bridge.stop();
    }
  });
});
