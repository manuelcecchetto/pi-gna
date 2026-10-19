import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_TOOLS, runPageTool, waitCheck } from "./page-scripts";

// The scripts are plain source run in the page; here they run against a stand-in document.
const run = (code: string): Promise<unknown> => Promise.resolve((0, eval)(code));

afterEach(() => vi.unstubAllGlobals());

function modelContext(executeTool: (tool: unknown, input: unknown) => Promise<string>) {
  const tool = { name: "echo", description: "Echo", inputSchema: '{"type":"object"}', annotations: { readOnlyHint: true } };
  vi.stubGlobal("document", { modelContext: { getTools: async () => [tool], executeTool } });
  return tool;
}

describe("runPageTool", () => {
  it("passes the input as a JSON string first (Chromium 152)", async () => {
    const execute = vi.fn(async (_tool: unknown, input: unknown) => `echo:${String(input)}`);
    modelContext(execute);
    expect(await run(runPageTool("echo", { text: "hi" }))).toEqual({ result: 'echo:{"text":"hi"}' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries with an object only when the browser refused to parse the string", async () => {
    const execute = vi.fn(async (_tool: unknown, input: unknown) => {
      if (typeof input === "string") throw new TypeError("Failed to parse input arguments");
      return `object:${JSON.stringify(input)}`;
    });
    modelContext(execute);
    expect(await run(runPageTool("echo", { text: "hi" }))).toEqual({ result: 'object:{"text":"hi"}' });
  });

  // A tool that failed while running has run: running it again could repeat its side effect.
  it("never reruns a tool that failed on its own", async () => {
    const execute = vi.fn(async () => {
      throw new TypeError("cart is undefined");
    });
    modelContext(execute);
    expect(await run(runPageTool("echo", {}))).toEqual({ error: "cart is undefined" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("names the page's tools when the one asked for is missing", async () => {
    modelContext(async () => "");
    expect(await run(runPageTool("nope", {}))).toEqual({ error: 'No page tool named "nope". The page has: echo.' });
  });

  it("reports a page without WebMCP", async () => {
    vi.stubGlobal("document", {});
    expect(await run(runPageTool("echo", {}))).toEqual({ error: expect.stringMatching(/no WebMCP tools/) });
    expect(await run(PAGE_TOOLS)).toBeNull();
  });
});

describe("PAGE_TOOLS", () => {
  it("reads name, description, schema and hints", async () => {
    modelContext(async () => "");
    expect(await run(PAGE_TOOLS)).toEqual([
      { name: "echo", title: undefined, description: "Echo", inputSchema: '{"type":"object"}', annotations: { readOnlyHint: true, untrustedContentHint: false, destructiveHint: false } },
    ]);
  });
});

describe("waitCheck", () => {
  it("lists every condition the page does not meet yet", async () => {
    vi.stubGlobal("document", { body: { innerText: "Loading… Saved" }, querySelector: () => null });
    vi.stubGlobal("location", { href: "http://localhost:5173/cart" });
    expect(await run(waitCheck({ text: "Saved", textGone: "Loading", selector: ".toast", url: "/checkout" }))).toEqual({
      missing: ['text "Loading" to disappear', 'a visible element matching ".toast"', 'a URL containing "/checkout"'],
    });
    expect(await run(waitCheck({ text: "Saved", url: "/cart" }))).toEqual({ missing: [] });
  });

  it("rejects an invalid selector", async () => {
    vi.stubGlobal("document", {
      body: { innerText: "" },
      querySelector: () => {
        throw new SyntaxError("bad");
      },
    });
    vi.stubGlobal("location", { href: "http://x/" });
    expect(await run(waitCheck({ selector: "[[" }))).toEqual({ invalid: 'Invalid CSS selector "[["' });
  });
});
