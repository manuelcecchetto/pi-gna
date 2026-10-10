import { describe, expect, it } from "vitest";
import { DESKTOP_ONLY_METHODS, HostError, formatEventId, isAllowedRpc, methodMutates, methodScope, parseEventId, planReplay } from "./host-api";

describe("event ids", () => {
  it("round-trips bootId:seq", () => {
    expect(parseEventId(formatEventId("abc_DEF-1", 42))).toEqual({ bootId: "abc_DEF-1", seq: 42 });
  });

  it("rejects malformed ids", () => {
    for (const bad of [undefined, null, "", "abc", ":5", "abc:", "abc:-1", "abc:1.5", "a b:1", "abc:1e3"]) expect(parseEventId(bad)).toBeNull();
  });
});

describe("planReplay", () => {
  it("replays the gap on the same boot", () => {
    expect(planReplay("b1:5", "b1", 3, 9)).toEqual({ kind: "replay", from: 6 });
    expect(planReplay("b1:9", "b1", 3, 9)).toEqual({ kind: "replay", from: 10 });
  });

  it("resyncs on a new boot, a missing id or an overflowed ring", () => {
    expect(planReplay("old:5", "b1", 3, 9)).toEqual({ kind: "resync", reason: "new_boot" });
    expect(planReplay(null, "b1", 3, 9)).toEqual({ kind: "resync", reason: "no_id" });
    expect(planReplay("b1:1", "b1", 5, 9)).toEqual({ kind: "resync", reason: "gap" });
    expect(planReplay("b1:2", "b1", null, 9)).toEqual({ kind: "resync", reason: "gap" });
    expect(planReplay("b1:20", "b1", 3, 9)).toEqual({ kind: "resync", reason: "gap" });
  });
});

describe("rpc allowlist", () => {
  it("allows the UI's commands and refuses bash and new_session", () => {
    expect(isAllowedRpc({ type: "prompt" })).toBe(true);
    expect(isAllowedRpc({ type: "abort" })).toBe(true);
    expect(isAllowedRpc({ type: "bash" })).toBe(false);
    expect(isAllowedRpc({ type: "new_session" })).toBe(false);
    expect(isAllowedRpc({})).toBe(false);
  });
});

describe("method scopes", () => {
  it("keeps host-UI methods desktop-only", () => {
    for (const method of DESKTOP_ONLY_METHODS) expect(methodScope(method)).toBe("desktop");
    expect(methodScope("chat.send")).toBe("remote");
    expect(methodScope("devices.pairStart")).toBe("desktop");
  });

  it("marks reads as non-mutating", () => {
    expect(methodMutates("board.get")).toBe(false);
    expect(methodMutates("chat.send")).toBe(true);
    expect(methodMutates("usage.get")).toBe(false);
    expect(methodMutates("usage.refresh")).toBe(true);
    expect(methodScope("usage.get")).toBe("remote");
  });
});

describe("HostError", () => {
  it("maps codes to statuses and a body", () => {
    const error = new HostError("conflict", "stale", { rev: 7 });
    expect(error.status).toBe(409);
    expect(error.toBody()).toEqual({ code: "conflict", message: "stale", detail: { rev: 7 } });
    expect(new HostError("unauthorized", "no").toBody()).toEqual({ code: "unauthorized", message: "no" });
  });
});
