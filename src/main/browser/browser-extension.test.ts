import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    for (const name of ["browser_page_tool", "browser_wait_for", "browser_dialog", "browser_upload", "browser_hover", "browser_select", "browser_drag", "browser_scroll", "browser_emulate"]) {
      expect(tools.map((tool) => tool.name)).toContain(name);
    }
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

  // Saved so the agent can embed it in its reply with ![caption](path).
  it("saves a screenshot to a path relative to the cwd when asked", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pigna-shot-"));
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ url: "http://localhost:5173/", title: "App", image: "/9j/AA==" }) }));
    const result = (await tools.find((tool) => tool.name === "browser_screenshot")?.execute?.("1", { save: "shots/home" }, undefined, undefined, { cwd })) as {
      content: { type: string; text?: string }[];
    };
    vi.unstubAllGlobals();
    const file = join(cwd, "shots", "home.jpg");
    expect(readFileSync(file)).toEqual(Buffer.from("/9j/AA==", "base64"));
    expect(result.content.find((block) => block.type === "text")?.text).toContain(`Saved to ${file}`);
  });

  // The bridge runs in pi-gna, not in the agent's directory: the extension hands it absolute paths of real files.
  it("resolves upload paths against the cwd and refuses missing files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pigna-upload-"));
    writeFileSync(join(cwd, "a.txt"), "a");
    const bodies: { files?: string[] }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ url: "http://localhost:5173/", title: "App", text: "Gave a.txt" }) };
    });
    const upload = tools.find((tool) => tool.name === "browser_upload");
    await upload?.execute?.("1", { ref: 2, files: ["a.txt"] }, undefined, undefined, { cwd, hasUI: false });
    await expect(upload?.execute?.("2", { ref: 2, files: ["missing.txt"] }, undefined, undefined, { cwd, hasUI: false })).rejects.toThrow(/No file at/);
    vi.unstubAllGlobals();
    expect(bodies).toEqual([{ action: "upload", ref: 2, files: [join(cwd, "a.txt")] }]);
  });

  it("accepts page tool arguments sent as a JSON string", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ url: "http://localhost:5173/", title: "App", text: "Ran" }) };
    });
    await tools.find((tool) => tool.name === "browser_page_tool")?.execute?.("1", { name: "echo", input: '{"text":"hi"}' }, undefined, undefined, { cwd: "/", hasUI: false });
    vi.unstubAllGlobals();
    expect(bodies).toEqual([{ action: "page_tool", name: "echo", input: { text: "hi" } }]);
  });

  it("puts the emulated media in the result", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ url: "http://localhost:5173/", title: "App", media: { colorScheme: "dark" } }) }));
    const result = (await tools.find((tool) => tool.name === "browser_emulate")?.execute?.("1", { colorScheme: "dark" }, undefined, undefined, { cwd: "/", hasUI: false })) as {
      content: { text: string }[];
    };
    vi.unstubAllGlobals();
    expect(result.content[0]?.text).toContain("Emulating: prefers-color-scheme: dark");
  });
});
