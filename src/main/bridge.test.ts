import { describe, expect, it } from "vitest";
import { AgentBridge } from "./bridge";

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
