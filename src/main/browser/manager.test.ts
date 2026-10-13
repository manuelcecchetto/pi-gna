import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Just enough of Electron for tabs that load, report their icon and are captured: no real pages.
const electron = vi.hoisted(() => {
  const shots = { count: 0, empty: false };
  const keepers: { destroyed: boolean; shown: boolean; contentView: { children: unknown[] } }[] = [];
  return { shots, keepers };
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
    loads: string[] = [];
    closed = false;
    reload = vi.fn();
    close = () => {
      this.closed = true;
    };
    focus = () => undefined;
    async loadURL(url: string) {
      this.loads.push(url);
      this.url = url;
      this.emit("did-navigate", {}, url);
    }
  }
  class WebContentsView {
    constructor(readonly options?: { webPreferences?: { offscreen?: boolean } }) {}
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
    // The keeper: an invisible window that holds views.
    BrowserWindow: class {
      static made = 0;
      destroyed = false;
      shown = false;
      size = [0, 0];
      contentView = {
        children: [] as unknown[],
        addChildView: (view: unknown) => this.contentView.children.push(view),
        removeChildView: (view: unknown) => this.contentView.children.splice(this.contentView.children.indexOf(view), 1),
      };
      title?: string;
      constructor(options: { width: number; height: number; title?: string }) {
        electron.keepers.push(this);
        this.size = [options.width, options.height];
        this.title = options.title;
      }
      setOpacity = () => undefined;
      setIgnoreMouseEvents = () => undefined;
      showInactive = () => {
        this.shown = true;
      };
      on = () => undefined;
      isDestroyed = () => this.destroyed;
      getContentSize = () => this.size;
      setContentSize = (width: number, height: number) => {
        this.size = [width, height];
      };
      destroy = () => {
        this.destroyed = true;
      };
    },
    nativeImage: { createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => false, getSize: () => ({ width: 16 }), toDataURL: () => `data:image/png;base64,${bytes.toString("base64")}` }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined, webRequest: { onBeforeSendHeaders: () => undefined } }) },
    shell: {},
    WebContentsView,
  };
});
vi.mock("../context-menu", () => ({ attachContextMenu: () => undefined }));
vi.mock("../site-icons", () => ({ siteIcon: async () => null }));

const { BrowserManager, KEEPER_TITLE } = await import("./manager");
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
  electron.keepers.length = 0;
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
    // The clock stands still from this capture on, so a slow machine does not age the still between the steps.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    manager.setLayout(pane(700));
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(now + 2999);
    await manager.still();
    expect(wc.capturePage).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(now + 3000);
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

type Fake = EventEmitter & { url: string; loads: string[]; closed: boolean; reload: ReturnType<typeof vi.fn>; loadURL(url: string): Promise<void> };

describe("BrowserManager agent copies of previews", () => {
  async function previewed() {
    const { manager, states } = setup();
    const dir = mkdtempSync(join(tmpdir(), "pigna-agent-copy-"));
    const file = join(dir, "notes.md");
    writeFileSync(file, "# Notes\n");
    writeFileSync(join(dir, "other.md"), "# Other\n");
    const tab = await manager.openPreview(file, { agent: "chat1", root: dir });
    const user = tab.view.webContents as unknown as Fake;
    return { manager, states, tab, user, file };
  }

  it("gives the agent its own page of a preview in the keeper, loaded once per file and view", async () => {
    const { manager, tab, user } = await previewed();
    const page = await manager.agentPage(tab);
    const copy = page.wc as unknown as Fake;
    expect(page).toMatchObject({ copy: true, scale: 1, touch: false });
    expect(copy).not.toBe(user);
    expect(copy.url).toBe(user.url);
    expect(electron.keepers[0]?.contentView.children).toContain(tab.agentView);
    const userLoads = user.loads.length;

    await manager.agentPage(tab);
    expect(copy.loads).toHaveLength(1);
    // A line loads the copy there; the user's tab is not touched.
    await manager.agentPage(tab, 12);
    expect(copy.loads.at(-1)).toBe(`${user.url}#L12`);
    manager.setPreviewMode(tab.id, "raw");
    await manager.agentPage(tab);
    expect(copy.loads.at(-1)).toMatch(/\?view=raw$/);
    expect(user.loads.length).toBe(userLoads + 1);
  });

  it("titles the keeper so a window manager rule can keep it from taking focus", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { manager, tab } = await previewed();
    await manager.agentPage(tab);
    expect((electron.keepers[0] as unknown as { title?: string }).title).toBe(KEEPER_TITLE);
    platform.mockRestore();
  });

  it("keeps the agent's copy in the shown keeper on macOS and Windows", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { manager, tab } = await previewed();
    await manager.agentPage(tab);
    expect((tab.agentView as unknown as { options?: { webPreferences?: { offscreen?: boolean } } }).options?.webPreferences?.offscreen).toBeFalsy();
    expect(electron.keepers[0]?.shown).toBe(true);
    platform.mockRestore();
  });

  // Wayland: a shown, opacity-0 keeper draws no frame for a still page, so Page.captureScreenshot never answers, and
  // showing it takes the keyboard focus from the user's app and adds a taskbar entry.
  it("renders the agent's copy offscreen on Linux, in a window that is never shown", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { manager, tab } = await previewed();
    await manager.agentPage(tab);
    expect((tab.agentView as unknown as { options?: { webPreferences?: { offscreen?: boolean } } }).options?.webPreferences?.offscreen).toBe(true);
    expect(electron.keepers).toHaveLength(1);
    expect(electron.keepers[0]?.contentView.children).toContain(tab.agentView);
    expect(electron.keepers[0]?.shown).toBe(false);
    manager.closeTab(tab.id);
    expect(electron.keepers[0]?.destroyed).toBe(true);
    platform.mockRestore();
  });

  it("acts on the page the user sees for a web tab", async () => {
    const { manager } = setup();
    const tab = manager.createTab("https://site.test/");
    const page = await manager.agentPage(tab);
    expect(page.wc).toBe(tab.view.webContents);
    expect(page.copy).toBe(false);
    expect(tab.agentView).toBeUndefined();
    expect(electron.keepers).toHaveLength(0);
  });

  it("carries the agent's move to another file to the tab, and a web link takes the tab off the copy", async () => {
    const { manager, tab, user } = await previewed();
    const copy = (await manager.agentPage(tab)).wc as unknown as Fake;
    const other = user.url.replace("notes.md", "other.md");
    await copy.loadURL(other);
    expect(user.url).toBe(other);
    expect(tab.preview?.info.name).toBe("other.md");
    const loads = user.loads.length;
    // The copy then follows the tab without carrying anything back.
    await manager.agentPage(tab);
    expect(user.loads).toHaveLength(loads);

    const event = { defaultPrevented: false, preventDefault() {
      this.defaultPrevented = true;
    } };
    copy.emit("will-navigate", event, "https://site.test/");
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(user.url).toBe("https://site.test/");
    expect(tab.preview).toBeUndefined();
    expect(tab.agentView).toBeUndefined();
    expect(copy.closed).toBe(true);
    expect(electron.keepers[0]?.destroyed).toBe(true);
    expect((await manager.agentPage(tab)).wc).toBe(tab.view.webContents);
  });

  it("sizes the copy to the agent's viewport, not the pane", async () => {
    const { manager, tab } = await previewed();
    await manager.agentPage(tab);
    const bounds = () => (tab.agentView as unknown as { bounds: { width: number; height: number } }).bounds;
    expect(bounds()).toMatchObject({ width: 1280, height: 800 });
    manager.setLayout(pane(400));
    expect(bounds()).toMatchObject({ width: 1280, height: 800 });
    const sent: string[] = [];
    Object.assign(tab.agentView!.webContents.debugger, { attach: () => undefined, sendCommand: async (method: string) => sent.push(method) });
    const spec = await manager.setAgentViewport(tab, { width: 390, height: 844, source: "agent" });
    expect(bounds()).toMatchObject({ width: 390, height: 844 });
    expect(sent).toEqual(["Emulation.setDeviceMetricsOverride"]);
    expect(manager.agentViewport(tab)).toBe(spec);
    expect(tab.viewport).toBeUndefined();
  });

  it("reloads the copy and bumps the revision when the file changes, and closes the copy with the tab", async () => {
    const { manager, tab, user, file } = await previewed();
    const copy = (await manager.agentPage(tab)).wc as unknown as Fake;
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(file, "# Notes, edited\n");
    await vi.waitFor(() => expect(copy.reload).toHaveBeenCalled(), { timeout: 3000 });
    expect(user.reload).toHaveBeenCalled();
    expect(tab.preview?.info.rev).toBeGreaterThan(0);
    await settle();
    expect(manager.snapshot().tabs[0]?.preview?.rev).toBe(tab.preview?.info.rev);
    manager.closeTab(tab.id);
    expect(copy.closed).toBe(true);
    expect(electron.keepers[0]?.destroyed).toBe(true);
  });
});
