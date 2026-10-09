import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Just enough of Electron for tabs that load, report their icon and are captured: no real pages.
const electron = vi.hoisted(() => {
  const shots = { count: 0, empty: false };
  return { shots };
});

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeContents extends Emitter {
    static next = 1;
    id = FakeContents.next++;
    url = "";
    title = "";
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    debugger = Object.assign(new Emitter(), { isAttached: () => false });
    session = { fetch: vi.fn(async () => new Response(Buffer.from("icon bytes"), { headers: { "content-type": "image/png" } })) };
    capturePage = vi.fn(async () => {
      const n = ++electron.shots.count;
      return { isEmpty: () => electron.shots.empty, toJPEG: (quality: number) => Buffer.from(`shot ${n} at ${quality}`) };
    });
    getURL = () => this.url;
    getTitle = () => this.title;
    isLoading = () => false;
    isDestroyed = () => false;
    isCrashed = () => false;
    setWindowOpenHandler = () => undefined;
    close = () => undefined;
    focus = () => undefined;
    async loadURL(url: string) {
      this.url = url;
      this.emit("did-navigate", {}, url);
    }
  }
  class WebContentsView {
    webContents = new FakeContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    setBackgroundColor = () => undefined;
    setBounds(bounds: { x: number; y: number; width: number; height: number }) {
      this.bounds = bounds;
    }
    getBounds() {
      return this.bounds;
    }
  }
  return {
    app: { getPath: () => "/nonexistent-pigna-test" },
    BrowserWindow: class {},
    nativeImage: { createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => false, getSize: () => ({ width: 16 }), toDataURL: () => `data:image/png;base64,${bytes.toString("base64")}` }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined, webRequest: { onBeforeSendHeaders: () => undefined } }) },
    shell: {},
    WebContentsView,
  };
});
vi.mock("../context-menu", () => ({ attachContextMenu: () => undefined }));
vi.mock("../site-icons", () => ({ siteIcon: async () => null }));

const { BrowserManager } = await import("./manager");
type Manager = InstanceType<typeof BrowserManager>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const window = () => ({ on: () => undefined, contentView: { addChildView: () => undefined, removeChildView: () => undefined, children: [] }, webContents: { getZoomFactor: () => 1 } });
const pane = (width = 800) => ({ visible: true, bounds: { x: 0, y: 0, width, height: 600 } });

function setup() {
  const states: unknown[] = [];
  const manager: Manager = new BrowserManager(window() as never, { state: (state) => states.push(state), reveal: () => undefined, annotation: () => undefined });
  return { manager, states };
}

/** The fake webContents of a tab. */
const contents = (manager: Manager, id: string) => manager.tabs.get(id)!.view.webContents as unknown as EventEmitter & { url: string; title: string; capturePage: ReturnType<typeof vi.fn>; session: { fetch: ReturnType<typeof vi.fn> } };

afterEach(() => {
  electron.shots.count = 0;
  electron.shots.empty = false;
  vi.restoreAllMocks();
});

describe("BrowserManager state", () => {
  it("publishes a state only when it changed", async () => {
    const { manager, states } = setup();
    const tab = manager.createTab("https://site.test/a");
    await settle();
    expect(states).toHaveLength(1);
    const wc = contents(manager, tab.id);
    wc.emit("page-title-updated");
    wc.emit("did-stop-loading");
    await settle();
    expect(states).toHaveLength(1);
    wc.title = "A";
    wc.emit("page-title-updated");
    await settle();
    expect(states).toHaveLength(2);
    expect((states[1] as { tabs: { title: string }[] }).tabs[0]?.title).toBe("A");
  });

  it("names a tab's icon by key, serves it by key, and loads a site's icon once", async () => {
    const { manager, states } = setup();
    const tab = manager.createTab("https://site.test/a");
    const wc = contents(manager, tab.id);
    wc.emit("page-favicon-updated", {}, ["https://site.test/icon.png"]);
    await vi.waitFor(() => expect(manager.snapshot().tabs[0]?.faviconKey).toBeTruthy());
    const key = manager.snapshot().tabs[0]!.faviconKey!;
    expect(manager.snapshot().tabs[0]).not.toHaveProperty("favicon");
    expect(manager.favicon(key)).toBe(`data:image/png;base64,${Buffer.from("icon bytes").toString("base64")}`);
    expect(manager.favicon("other")).toBeNull();
    await settle();
    expect(JSON.stringify(states.at(-1))).not.toContain("data:image");

    // Another page of the site: the icon comes from the cache, the key stays.
    await wc.emit("did-navigate", {}, "https://site.test/b");
    wc.url = "https://site.test/b";
    wc.emit("page-favicon-updated", {}, ["https://site.test/icon.png"]);
    await settle();
    expect(wc.session.fetch).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().tabs[0]?.faviconKey).toBe(key);

    // A tab on another site gets its own icon; closing the first tab stops serving the first key.
    const other = manager.createTab("https://elsewhere.test/");
    contents(manager, other.id).session.fetch.mockImplementation(async () => new Response(Buffer.from("other icon"), { headers: { "content-type": "image/png" } }));
    contents(manager, other.id).emit("page-favicon-updated", {}, ["https://elsewhere.test/icon.png"]);
    await vi.waitFor(() => expect(manager.snapshot().tabs[1]?.faviconKey).toBeTruthy());
    expect(manager.snapshot().tabs[1]?.faviconKey).not.toBe(key);
    manager.closeTab(tab.id);
    expect(manager.favicon(key)).toBeNull();
  });
});

describe("BrowserManager stills", () => {
  async function shown() {
    const { manager } = setup();
    const tab = manager.createTab("https://site.test/a");
    manager.setLayout(pane());
    await settle();
    return { manager, tab, wc: contents(manager, tab.id) };
  }

  it("captures the pane's page as a JPEG at 75 and reuses it while nothing changed", async () => {
    const { manager, wc } = await shown();
    const first = await manager.still();
    expect(first).toBe(`data:image/jpeg;base64,${Buffer.from("shot 1 at 75").toString("base64")}`);
    expect(await manager.still()).toBe(first);
    expect(wc.capturePage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a navigation", (wc: EventEmitter) => wc.emit("did-navigate", {}, "https://site.test/b")],
    ["an in-page navigation", (wc: EventEmitter) => wc.emit("did-navigate-in-page")],
    ["a load", (wc: EventEmitter) => wc.emit("did-stop-loading")],
    ["a title", (wc: EventEmitter) => wc.emit("page-title-updated")],
    ["input in the page", (wc: EventEmitter) => wc.emit("input-event", {}, { type: "mouseDown" })],
  ])("captures again after %s", async (_name, change) => {
    const { manager, wc } = await shown();
    const first = await manager.still();
    change(wc);
    const second = await manager.still();
    expect(second).not.toBe(first);
    expect(wc.capturePage).toHaveBeenCalledTimes(2);
  });

  it("captures again when the agent or a phone acted, the pane moved, or the still is old", async () => {
    const { manager, tab, wc } = await shown();
    await manager.still();
    manager.staleStill(tab);
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(2);
    manager.setLayout(pane(700));
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(3);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2999);
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(3);
    vi.spyOn(Date, "now").mockReturnValue(now + 3001);
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(4);
  });

  it("keeps a still across another tab's changes, and has none once the pane shows nothing", async () => {
    const { manager, tab, wc } = await shown();
    const other = manager.createTab("https://site.test/other");
    manager.activate(tab.id);
    await manager.still();
    contents(manager, other.id).emit("did-navigate-in-page");
    manager.staleStill(manager.tabs.get(other.id)!);
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(1);
    manager.activate(other.id);
    await manager.still();
    expect(contents(manager, other.id).capturePage).toHaveBeenCalledTimes(1);
    manager.setLayout({ visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    expect(await manager.still()).toBeUndefined();
  });

  it("does not reuse a failed capture", async () => {
    const { manager, wc } = await shown();
    electron.shots.empty = true;
    expect(await manager.still()).toBeUndefined();
    electron.shots.empty = false;
    expect(await manager.still()).toMatch(/^data:image\/jpeg;base64,/);
    expect(wc.capturePage).toHaveBeenCalledTimes(2);
  });
});
