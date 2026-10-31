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

describe("AgentBridge WebSockets", () => {
  /** Opens a WebSocket at `path`; resolves "open" or the close code the bridge refused it with. */
  const connect = (url: string, headers?: Record<string, string>) =>
    new Promise<{ socket?: WebSocket; refused?: true }>((resolve) => {
      // Node's WebSocket takes headers (undici); a browser's sends its Origin by itself.
      const socket = new (WebSocket as unknown as new (url: string, options?: unknown) => WebSocket)(url, headers ? { headers } : undefined);
      socket.onopen = () => resolve({ socket });
      socket.onerror = () => resolve({ refused: true });
    });

  it("serves a socket route to a valid token only, with no Origin, and closes it when the token is unregistered", async () => {
    const bridge = new AgentBridge();
    await bridge.start();
    try {
      const handles: (string | undefined)[] = [];
      const ws = bridge.url.replace("http:", "ws:");
      let current: (() => string | undefined) | undefined;
      bridge.socketRoute("echo", (handle, socket) => {
        current = handle;
        socket.onMessage((text) => {
          handles.push(handle());
          socket.send(text);
        });
      });
      const token = bridge.register("chat1");
      expect((await connect(`${ws}/echo/wrong`)).refused).toBe(true);
      expect((await connect(`${ws}/nope/${token}`)).refused).toBe(true);
      expect((await connect(`${ws}/echo/${token}`, { origin: "https://evil.example" })).refused).toBe(true);

      const { socket } = await connect(`${ws}/echo/${token}`);
      const reply = new Promise((resolve) => (socket!.onmessage = (event) => resolve(event.data)));
      socket!.send("ping");
      expect(await reply).toBe("ping");
      expect(handles).toEqual(["chat1"]);
      bridge.rename("chat1", "chat2");
      expect(current?.()).toBe("chat2");

      const closed = new Promise<number>((resolve) => (socket!.onclose = (event) => resolve(event.code)));
      bridge.unregister("chat2");
      expect(await closed).toBe(1008);
      expect(current?.()).toBeUndefined();
    } finally {
      bridge.stop();
    }
  });
});
