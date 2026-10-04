import { beforeAll, describe, expect, it, vi } from "vitest";

// pi provides typebox to extensions at load time; the schemas themselves do not matter here.
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));

interface Registered {
  name: string;
  executionMode?: string;
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
});
