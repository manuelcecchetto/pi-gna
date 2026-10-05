import { describe, expect, it, vi } from "vitest";
import type { Model, RpcCommand, RpcResponse } from "../shared/protocol";
import type { HostClient } from "./client/host-client";
import { hasLevels, loadCommands, loadLevels, loadModels, projectFiles, switchModel } from "./composer-data";

const model = { id: "big", name: "Big", provider: "p", api: "x", reasoning: true, input: [], contextWindow: 1, maxTokens: 1 } as Model;
const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data }) as RpcResponse;

describe("composer reads", () => {
  it("returns the lists pi answers and nothing when it refuses or the call fails", async () => {
    expect(await loadCommands(async () => ok({ commands: [{ name: "compact", source: "extension" }] }))).toHaveLength(1);
    expect(await loadModels(async () => ({ type: "response", command: "x", success: false, error: "no" }) as RpcResponse)).toBeUndefined();
    expect(await loadLevels(async () => Promise.reject(new Error("offline")))).toBeUndefined();
  });
});

describe("switchModel", () => {
  it("sets the model, then reads the levels and thinking level it leaves", async () => {
    const seen: string[] = [];
    const call = async (command: RpcCommand): Promise<RpcResponse> => {
      seen.push(command.type);
      if (command.type === "get_available_thinking_levels") return ok({ levels: ["off", "high"] });
      if (command.type === "get_state") return ok({ thinkingLevel: "high" });
      return ok(model);
    };
    const result = await switchModel(call, model);
    expect(result).toEqual({ ok: true, model, levels: ["off", "high"], thinkingLevel: "high" });
    expect(seen[0]).toBe("set_model");
  });
  it("reports a refusal without reading further", async () => {
    const call = vi.fn(async (): Promise<RpcResponse> => ({ type: "response", command: "set_model", success: false, error: "Unknown model" }) as RpcResponse);
    expect(await switchModel(call, model)).toEqual({ ok: false, error: "Unknown model" });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("hasLevels", () => {
  it("is false for no levels or only off", () => {
    expect(hasLevels(undefined)).toBe(false);
    expect(hasLevels(["off"])).toBe(false);
    expect(hasLevels(["off", "low"])).toBe(true);
  });
});

describe("projectFiles", () => {
  it("lists once within the TTL and again after it", async () => {
    const call = vi.fn(async () => ["a.ts"]);
    const client = { call } as unknown as HostClient;
    expect(await projectFiles(client, "/ttl", 1000)).toEqual(["a.ts"]);
    await projectFiles(client, "/ttl", 5000);
    expect(call).toHaveBeenCalledTimes(1);
    await projectFiles(client, "/ttl", 20_000);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
