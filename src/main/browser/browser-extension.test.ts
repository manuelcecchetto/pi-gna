import { beforeAll, describe, expect, it, vi } from "vitest";

// pi provides typebox to extensions at load time; the schemas themselves do not matter here.
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));

interface Registered {
  name: string;
  executionMode?: string;
  execute?: (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown>;
}

describe("browser extension", () => {
  const tools: Registered[] = [];

  beforeAll(async () => {
    process.env.PIGNA_BRIDGE = "http://127.0.0.1:1";
    process.env.PIGNA_TOKEN = "test";
    // Not a literal path: tsc would type-check the extension, whose pi types this project does not install.
    const path = "../../../resources/browser-extension";
    const { default: register } = (await import(path)) as { default: (pi: unknown) => void };
    register({ registerTool: (tool: Registered) => tools.push(tool) });
  });

  it("registers the browser tools", () => {
    expect(tools.map((tool) => tool.name)).toContain("browser_screenshot");
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });

  // pi runs a message's tool calls in parallel otherwise, and the bridge would order them by arrival:
  // a screenshot issued after browser_open captured the previous page.
  it("makes every browser tool sequential", () => {
    expect(tools.filter((tool) => tool.executionMode !== "sequential").map((tool) => tool.name)).toEqual([]);
  });

  // A local path is previewed: the bridge gets the path and cwd, with no origin approval and no URL rewriting.
  it("sends local paths to the bridge as a preview open", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ url: "/p/README.md", title: "README.md" }) };
    });
    const ctx = { cwd: "/p", hasUI: false };
    await tools.find((tool) => tool.name === "browser_open")?.execute?.("1", { url: "./README.md" }, undefined, undefined, ctx);
    vi.unstubAllGlobals();
    expect(bodies).toEqual([{ action: "open", url: "./README.md", cwd: "/p" }]);
  });
});
