import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: {} }));

const { BrowserAgent } = await import("./agent");

describe("BrowserAgent", () => {
  it("drops the pane's still of a page once the agent has acted on it", async () => {
    const order: string[] = [];
    const tab = { id: "t1", agent: "h1", console: [], view: { webContents: { getURL: () => "https://site.test/", getTitle: () => "Site" } } };
    const browser = {
      tabs: new Map([["t1", tab]]),
      active: () => tab,
      hold: () => order.push("hold"),
      release: () => order.push("release"),
      markAgent: () => order.push("mark"),
      staleStill: (stale: unknown) => order.push(stale === tab ? "stale" : "other"),
      agentPage: async () => ({ wc: tab.view.webContents, scale: 1, touch: false, copy: false }),
      agentViewport: () => undefined,
    };
    expect(await new BrowserAgent(browser as never).run("h1", { action: "console", tab: "t1" })).toMatchObject({ url: "https://site.test/", text: "No console messages." });
    expect(order).toEqual(["hold", "mark", "stale", "release"]);
  });

  it("reads a file preview from the agent's own copy, without drawing or holding the user's tab", async () => {
    const calls: string[] = [];
    const user = { getURL: () => "pigna-file://t/a.md", getTitle: () => "user" };
    const copy = {
      getURL: () => "pigna-file://t/a.md",
      getTitle: () => "copy",
      executeJavaScriptInIsolatedWorld: async () => ({ url: "pigna-file://t/a.md", title: "copy", text: "# A", refs: 0 }),
    };
    const tab = { id: "t1", agent: "h1", console: [], preview: { info: { path: "/p/a.md" } }, view: { webContents: user } };
    const browser = {
      tabs: new Map([["t1", tab]]),
      active: () => tab,
      hold: () => calls.push("hold"),
      release: () => calls.push("release"),
      markAgent: () => undefined,
      staleStill: () => undefined,
      ensureVisible: async () => calls.push("ensureVisible"),
      agentPage: async () => (calls.push("agentPage"), { wc: copy, scale: 1, touch: false, copy: true }),
      agentViewport: () => undefined,
    };
    expect(await new BrowserAgent(browser as never).run("h1", { action: "snapshot" })).toMatchObject({ title: "copy", text: "# A" });
    expect(calls).toEqual(["agentPage"]);
  });

  it("draws a web page where the user sees it before reading it", async () => {
    const calls: string[] = [];
    const wc = {
      getURL: () => "https://site.test/",
      getTitle: () => "Site",
      executeJavaScriptInIsolatedWorld: async () => ({ url: "https://site.test/", title: "Site", text: "page", refs: 0 }),
    };
    const tab = { id: "t1", agent: "h1", console: [], view: { webContents: wc } };
    const browser = {
      tabs: new Map([["t1", tab]]),
      active: () => tab,
      hold: () => calls.push("hold"),
      release: () => calls.push("release"),
      markAgent: () => undefined,
      staleStill: () => undefined,
      ensureVisible: async () => calls.push("ensureVisible"),
      agentPage: async () => (calls.push("agentPage"), { wc, scale: 1, touch: false, copy: false }),
      agentViewport: () => undefined,
    };
    expect(await new BrowserAgent(browser as never).run("h1", { action: "snapshot" })).toMatchObject({ text: "page" });
    expect(calls).toEqual(["hold", "ensureVisible", "agentPage", "release"]);
  });
});
