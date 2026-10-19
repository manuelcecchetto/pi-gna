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

/** A tab that never opens a dialog. */
const noDialog = () => ({ opened: new Promise<never>(() => undefined), cancel: () => undefined });

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
    nextDialog: noDialog,
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
      nextDialog: noDialog,
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
      nextDialog: noDialog,
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
      nextDialog: noDialog,
    };
    expect(await new BrowserAgent(browser as never).run("h1", { action: "snapshot" })).toMatchObject({ text: "page" });
    expect(calls).toEqual(["hold", "ensureVisible", "agentPage", "release"]);
  });
});

/** A web tab and a fake BrowserManager around it; `script` answers each isolated-world script by its source. */
function webTab(script: (code: string) => unknown, sendCommand: (method: string, params: { type?: string }) => Promise<unknown> = async () => ({})) {
  const wc = {
    getURL: () => "http://localhost:5173/",
    getTitle: () => "App",
    isLoading: () => false,
    on: () => undefined,
    off: () => undefined,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => script(scripts[0]?.code ?? ""),
    debugger: { isAttached: () => true, sendCommand, on: () => undefined, off: () => undefined },
  };
  const tab: Record<string, unknown> = { id: "t1", agent: "h1", console: [], view: { webContents: wc } };
  let open: ((dialog: unknown) => void) | undefined;
  const browser = {
    tabs: new Map([["t1", tab]]),
    active: () => tab,
    hold: () => undefined,
    release: () => undefined,
    markAgent: () => undefined,
    staleStill: () => undefined,
    ensureVisible: async () => undefined,
    agentPage: async () => ({ wc, scale: 1, touch: false, copy: false }),
    agentViewport: () => undefined,
    nextDialog: () => ({ opened: new Promise((resolve) => (open = resolve)), cancel: () => (open = undefined) }),
  };
  return { tab, browser, agent: new BrowserAgent(browser as never), openDialog: (dialog: unknown) => open?.(dialog), waiting: () => !!open };
}

describe("BrowserAgent dialogs", () => {
  // The click's input event waits until the dialog it opened is answered; without the race, browser_dialog would queue
  // behind it forever.
  it("reports a dialog an action opens instead of waiting for it", async () => {
    const page = webTab(
      () => ({ x: 5, y: 5 }),
      (_method, params) => (params.type === "mouseReleased" ? new Promise(() => undefined) : Promise.resolve({})),
    );
    const pending = page.agent.run("h1", { action: "click", ref: 1 });
    await vi.waitFor(() => expect(page.waiting()).toBe(true));
    const answer = vi.fn();
    const dialog = { type: "confirm", message: "Delete it?", answer };
    page.tab.dialog = dialog;
    page.openDialog(dialog);
    expect((await pending).text).toMatch(/showing a confirm dialog: "Delete it\?".*browser_dialog/);

    // Anything but answering it would block on the paused page.
    await expect(page.agent.run("h1", { action: "evaluate", expression: "1" })).rejects.toThrow(/confirm dialog/);
    expect((await page.agent.run("h1", { action: "console" })).text).toBe("No console messages.");

    const answered = await page.agent.run("h1", { action: "dialog", accept: false });
    expect(answer).toHaveBeenCalledWith(false);
    expect(answered.text).toMatch(/^Dismissed the confirm dialog "Delete it\?"/);
  });

  it("says so when there is no dialog to answer", async () => {
    const page = webTab(() => null);
    await expect(page.agent.run("h1", { action: "dialog", accept: true })).rejects.toThrow(/No dialog/);
  });
});

describe("BrowserAgent page tools (WebMCP)", () => {
  const tools = [{ name: "set_style", description: "Set the pizza style", inputSchema: '{"type":"object","properties":{"style":{"type":"string"}}}', annotations: { readOnlyHint: false } }];

  it("lists the page's tools in the snapshot and with their schemas on request", async () => {
    const page = webTab((code) => (code.includes("getTools") ? tools : { url: "http://localhost:5173/", title: "App", text: "[1] button \"Go\"", refs: 1 }));
    const snap = await page.agent.run("h1", { action: "snapshot" });
    expect(snap.text).toContain('[1] button "Go"');
    expect(snap.text).toMatch(/Page tools \(WebMCP.*\n- set_style: Set the pizza style$/);
    const listed = await page.agent.run("h1", { action: "page_tool" });
    expect(listed.text).toContain('input: {"type":"object","properties":{"style":{"type":"string"}}}');
  });

  it("runs a page tool and returns its result", async () => {
    const scripts: string[] = [];
    const page = webTab((code) => (scripts.push(code), { result: "Changed pizza style to Pesto" }));
    const result = await page.agent.run("h1", { action: "page_tool", name: "set_style", input: { style: "Pesto" } });
    expect(result.text).toMatch(/^Ran page tool set_style\..*\n\nResult:\nChanged pizza style to Pesto$/s);
    expect(scripts[0]).toContain('{"style":"Pesto"}');
  });

  it("fails with the page's error", async () => {
    const page = webTab(() => ({ error: "No page tool named \"nope\". The page has: set_style." }));
    await expect(page.agent.run("h1", { action: "page_tool", name: "nope" })).rejects.toThrow(/Page tool nope failed: No page tool named "nope"/);
  });
});

describe("BrowserAgent wait_for", () => {
  it("checks the page until the condition holds, then returns a snapshot", async () => {
    let checks = 0;
    const page = webTab((code) => {
      if (code.includes("missing.push")) return { missing: ++checks < 3 ? ['text "Saved"'] : [] };
      if (code.includes("getTools")) return null;
      return { url: "http://localhost:5173/", title: "App", text: "Saved", refs: 0 };
    });
    const result = await page.agent.run("h1", { action: "wait_for", text: "Saved" });
    expect(checks).toBe(3);
    expect(result.text).toMatch(/^Condition met after \d+\.\d s\.\n\nSaved$/);
  });

  it("fails with what is still missing after the timeout", async () => {
    const page = webTab(() => ({ missing: ['a visible element matching ".toast"'] }));
    await expect(page.agent.run("h1", { action: "wait_for", selector: ".toast", timeout: 300 })).rejects.toThrow(/Still waiting after 0\.3 s for a visible element matching "\.toast"/);
  });

  it("needs a condition", async () => {
    const page = webTab(() => ({ missing: [] }));
    await expect(page.agent.run("h1", { action: "wait_for" })).rejects.toThrow(/at least one/);
  });
});

describe("BrowserAgent select", () => {
  it("explains a ref that is not a native select", async () => {
    const page = webTab(() => ({ error: "not-select", tag: "div" }));
    await expect(page.agent.run("h1", { action: "select", ref: 3, values: ["a"] })).rejects.toThrow(/\[3\] is a <div>, not a native <select>/);
  });

  it("lists the options when none matches", async () => {
    const page = webTab(() => ({ error: "no-option", value: "XL", available: ["Small", "Large"] }));
    await expect(page.agent.run("h1", { action: "select", ref: 3, values: ["XL"] })).rejects.toThrow(/no option "XL"\. Options: Small \| Large/);
  });
});
