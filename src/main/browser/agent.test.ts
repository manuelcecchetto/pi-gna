import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => image(bytes.toString()),
  },
}));

/** A fake nativeImage whose JPEG is its label, so a test can tell which capture produced it. */
function image(label: string) {
  return { isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), resize: () => image(label), toJPEG: () => Buffer.from(label) };
}

const { BrowserAgent } = await import("./agent");

/** A preview tab whose agent copy is `wc`, so actions skip the pane. */
function previewBrowser(wc: unknown) {
  const tab = { id: "t1", agent: "h1", console: [], preview: { info: { path: "/p/a.md" } }, view: { webContents: wc } };
  return {
    tabs: new Map([["t1", tab]]),
    active: () => tab,
    hold: () => undefined,
    release: () => undefined,
    markAgent: () => undefined,
    staleStill: () => undefined,
    agentPage: async () => ({ wc, scale: 1, touch: false, copy: true }),
    agentViewport: () => undefined,
  };
}

describe("BrowserAgent input and capture", () => {
  // A hover move is acked only after the page draws a frame, which a minimized window or one on another virtual desktop
  // does not do on Wayland: awaiting it cost ~5 s per click there. The press and release still land in order.
  it("clicks without waiting for the hover move's ack", async () => {
    const sent: string[] = [];
    const wc = {
      getURL: () => "pigna-file://t/a.md",
      getTitle: () => "A",
      isLoading: () => false,
      on: () => undefined,
      off: () => undefined,
      executeJavaScriptInIsolatedWorld: async () => ({ x: 10, y: 20 }),
      debugger: {
        isAttached: () => true,
        sendCommand: (method: string, params: { type?: string }) => {
          sent.push(params.type ?? method);
          return params.type === "mouseMoved" ? new Promise(() => undefined) : Promise.resolve({});
        },
      },
    };
    const result = await new BrowserAgent(previewBrowser(wc) as never).run("h1", { action: "click", ref: 1 });
    expect(result.text).toMatch(/^Clicked \[1\]/);
    expect(sent).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("falls back to capturing the view when the page draws no frame for a screenshot", async () => {
    vi.useFakeTimers();
    try {
      const wc = {
        getURL: () => "pigna-file://t/a.md",
        getTitle: () => "A",
        debugger: { isAttached: () => true, sendCommand: () => new Promise(() => undefined) },
        capturePage: async () => image("captured"),
      };
      const pending = new BrowserAgent(previewBrowser(wc) as never).run("h1", { action: "screenshot" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).image).toBe(Buffer.from("captured").toString("base64"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a screenshot that gets no frame at all instead of blocking the tab", async () => {
    vi.useFakeTimers();
    try {
      const wc = {
        getURL: () => "pigna-file://t/a.md",
        getTitle: () => "A",
        debugger: { isAttached: () => true, sendCommand: () => new Promise(() => undefined) },
        capturePage: () => new Promise(() => undefined),
      };
      const pending = new BrowserAgent(previewBrowser(wc) as never).run("h1", { action: "screenshot" });
      const outcome = pending.then(() => "resolved", (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await outcome).toMatch(/did not draw/);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
