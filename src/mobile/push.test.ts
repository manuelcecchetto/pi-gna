import { describe, expect, it } from "vitest";
import { chatOfHash, keyBytes, pushAvailability } from "./push";

const env = { hasPush: true, standalone: true, ios: true, permission: "default" as const };

describe("pushAvailability", () => {
  it("asks for the Home Screen app on iOS before anything else", () => {
    expect(pushAvailability({ ...env, standalone: false, hasPush: false })).toBe("needs_install");
  });
  it("tells ready, denied and unsupported apart", () => {
    expect(pushAvailability(env)).toBe("ready");
    expect(pushAvailability({ ...env, permission: "denied" })).toBe("denied");
    expect(pushAvailability({ ...env, hasPush: false })).toBe("unsupported");
    expect(pushAvailability({ ...env, ios: false, standalone: false })).toBe("ready");
  });
});

describe("deep link and key", () => {
  it("reads a chat handle from the hash only", () => {
    expect(chatOfHash("#/chat/ab12_-Z")).toBe("ab12_-Z");
    expect(chatOfHash("#/chat/")).toBeUndefined();
    expect(chatOfHash("#/chat/a/b")).toBeUndefined();
    expect(chatOfHash("")).toBeUndefined();
  });
  it("decodes a base64url key", () => {
    expect([...keyBytes("BAEC_w")]).toEqual([4, 1, 2, 255]);
  });
});
