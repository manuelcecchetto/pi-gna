// Browser tabs: one WebContentsView per tab in a persistent profile separate from the app.
// The renderer owns layout (where the pane is); main owns pages, history and annotations.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, session, WebContentsView, type WebContents } from "electron";
import {
  type Annotation,
  type BrowserCommand,
  type BrowserLayout,
  type BrowserState,
  type HistoryEntry,
  normalizeAddress,
} from "../../shared/browser";
import { fitViewport, resolveViewport, userAgentFor, type ViewportRequest, type ViewportSpec } from "../../shared/viewport";
import { attachContextMenu } from "../context-menu";
import { log } from "../log";
import { cdp } from "./cdp";
import { ANNOTATE, ISOLATED_WORLD, STOP_ANNOTATE } from "./page-scripts";

export const PARTITION = "persist:pigna-browser";
const CONSOLE_LIMIT = 300;
const HISTORY_LIMIT = 500;
/** Standalone device windows open at once. */
export const WINDOW_LIMIT = 4;

export interface ConsoleEntry {
  level: string;
  message: string;
  source: string;
  at: number;
}

export interface Tab {
  id: string;
  view: WebContentsView;
  console: ConsoleEntry[];
  agent?: string;
  viewport?: ViewportSpec;
  /** Fit scale last sent to Emulation.setDeviceMetricsOverride; undefined when not applied yet. */
  emulatedScale?: number;
  /** "pane" for the browser pane, otherwise the id of the BrowserWindow the tab lives in. */
  surface: "pane" | number;
  win?: BrowserWindow;
  /** The viewport was made up when popping out a tab that had none; returning to the pane drops it again. */
  autoViewport?: boolean;
}

export interface BrowserEvents {
  state(state: BrowserState): void;
  /** Ask the renderer to show the pane (the agent is about to use it). */
  reveal(): void;
  annotation(annotation: Annotation): void;
}

export class BrowserManager {
  readonly tabs = new Map<string, Tab>();
  private order: string[] = [];
  /** The tab the agent and toolbar address; may live in a window. */
  private activeId?: string;
  /** The pane tab that is drawn in the pane. */
  private paneId?: string;
  private layout: BrowserLayout = { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  private attached?: WebContentsView;
  private annotating = false;
  private annotateGeneration = 0;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private visibleWaiters: (() => void)[] = [];
  private history: HistoryEntry[] = [];
  private historyTimer?: ReturnType<typeof setTimeout>;
  /** Client-hint headers Electron does not send itself, by webContents id, for emulated tabs. */
  private readonly hintHeaders = new Map<number, Record<string, string>>();
  private readonly historyPath = join(app.getPath("userData"), "browser-history.json");

  constructor(
    private readonly window: BrowserWindow,
    private readonly events: BrowserEvents,
  ) {
    const profile = session.fromPartition(PARTITION);
    // Pages get no camera, microphone, location or notifications.
    profile.setPermissionRequestHandler((_wc, permission, callback) => callback(["clipboard-sanitized-write", "fullscreen"].includes(permission)));
    profile.webRequest.onBeforeSendHeaders((details, callback) => {
      const extra = details.webContentsId === undefined ? undefined : this.hintHeaders.get(details.webContentsId);
      callback({ requestHeaders: extra ? { ...details.requestHeaders, ...extra } : details.requestHeaders });
    });
    // Device windows belong to the app window.
    window.on("close", () => {
      for (const tab of [...this.tabs.values()]) if (tab.win) this.closeTab(tab.id);
    });
    void readFile(this.historyPath, "utf8")
      .then((text) => {
        this.history = JSON.parse(text) as HistoryEntry[];
      })
      .catch(() => undefined);
  }

  // ── State ──────────────────────────────────────────────────────────────────

  snapshot(): BrowserState {
    return {
      activeId: this.activeId,
      annotating: this.annotating,
      tabs: this.order.flatMap((id) => {
        const tab = this.tabs.get(id);
        if (!tab) return [];
        const wc = tab.view.webContents;
        return [
          {
            id,
            url: wc.getURL(),
            title: wc.getTitle(),
            loading: wc.isLoading(),
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
            agent: tab.agent,
            viewport: tab.viewport,
            surface: tab.win ? ("window" as const) : ("pane" as const),
          },
        ];
      }),
    };
  }

  private emitState(): void {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => this.events.state(this.snapshot()), 30);
  }

  getHistory(): HistoryEntry[] {
    return this.history;
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  private makeTab(agent?: string): Tab {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    view.setBackgroundColor("#ffffff");
    const tab: Tab = { id: randomUUID().slice(0, 8), view, console: [], agent, surface: "pane" };
    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);
    this.wire(tab);
    return tab;
  }

  createTab(url?: string, agent?: string): Tab {
    const tab = this.makeTab(agent);
    this.activate(tab.id);
    if (url) void this.load(tab, url);
    return tab;
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const changed = () => this.emitState();
    wc.on("did-start-loading", changed);
    wc.on("did-stop-loading", changed);
    wc.on("page-title-updated", changed);
    wc.on("did-navigate-in-page", changed);
    wc.on("did-navigate", (_event, url) => {
      changed();
      this.remember(url, wc);
      if (this.annotating && tab.id === this.activeId) void this.annotateLoop();
    });
    wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.pushConsole(tab, "error", `Failed to load ${url}: ${description} (${code})`, "browser");
    });
    wc.on("render-process-gone", (_event, details) => {
      this.pushConsole(tab, "error", `Page crashed: ${details.reason}`, "browser");
      this.reapply(tab);
    });
    // The user can cancel debugging from the DevTools banner; emulation goes with the session.
    wc.debugger.on("detach", () => this.reapply(tab));
    wc.on("console-message", (details) => {
      // Electron's dev-mode security banner is about the host app, not the page.
      if (details.message.startsWith("Electron Security Warning")) return;
      this.pushConsole(tab, details.level, details.message, `${details.sourceId.split("/").at(-1) ?? ""}:${details.lineNumber}`);
    });
    // Popups and target=_blank links open as tabs in the same pane.
    wc.setWindowOpenHandler(({ url }) => {
      this.createTab(url, tab.agent);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (!/^(https?|file|about|data|blob):/i.test(url)) event.preventDefault();
    });
    attachContextMenu(wc, { page: true, openTab: (url) => this.createTab(url) });
  }

  private pushConsole(tab: Tab, level: string, message: string, source: string): void {
    tab.console.push({ level, message: message.slice(0, 2000), source, at: Date.now() });
    if (tab.console.length > CONSOLE_LIMIT) tab.console.splice(0, tab.console.length - CONSOLE_LIMIT);
  }

  private remember(url: string, wc: WebContents): void {
    if (!/^https?:/i.test(url)) return;
    this.history = [{ url, title: wc.getTitle(), at: Date.now() }, ...this.history.filter((entry) => entry.url !== url)].slice(0, HISTORY_LIMIT);
    clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => void writeFile(this.historyPath, JSON.stringify(this.history)).catch(() => undefined), 1000);
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const index = this.order.indexOf(id);
    this.order.splice(index, 1);
    this.tabs.delete(id);
    this.hintHeaders.delete(tab.view.webContents.id);
    if (this.attached === tab.view) this.detach();
    // The tab is already gone, so the window's "closed" handler finds nothing to do.
    if (tab.win && !tab.win.isDestroyed()) tab.win.close();
    tab.view.webContents.close();
    if (this.paneId === id) {
      this.paneId = undefined;
      const next = [this.order[index], this.order[index - 1]].find((candidate) => candidate && this.tabs.get(candidate)?.surface === "pane");
      if (next) this.paneId = next;
    }
    if (this.activeId === id) {
      this.activeId = undefined;
      const next = this.order[index] ?? this.order[index - 1];
      if (next) this.activate(next);
    }
    this.applyLayout();
    this.emitState();
  }

  activate(id: string): void {
    if (!this.tabs.has(id)) return;
    if (this.annotating && this.activeId !== id) this.setAnnotating(false);
    this.activeId = id;
    if (this.tabs.get(id)?.surface === "pane") this.paneId = id;
    this.applyLayout();
    this.emitState();
  }

  active(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined;
  }

  navigate(id: string, input: string): void {
    const tab = this.tabs.get(id);
    if (tab) void this.load(tab, normalizeAddress(input));
  }

  /** Load a URL; resolves when the main frame finished or failed (failures land in the tab console). */
  async load(tab: Tab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      const message = (error as Error).message;
      if (!message.includes("ERR_ABORTED")) throw error;
    }
  }

  command(id: string, command: BrowserCommand): void {
    const wc = this.tabs.get(id)?.view.webContents;
    if (!wc) return;
    if (command === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (command === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (command === "reload") wc.reload();
    else if (command === "stop") wc.stop();
  }

  inspect(id: string): void {
    this.tabs.get(id)?.view.webContents.openDevTools({ mode: "detach" });
  }

  // ── Windows ────────────────────────────────────────────────────────────────

  /** Open a tab in its own window whose content is exactly spec.width x spec.height DIPs (the OS may clamp it to the screen). */
  async openWindow(request: ViewportRequest, url?: string, agent?: string): Promise<Tab> {
    this.assertWindowSlot();
    const spec = resolveViewport(request);
    const tab = this.makeTab(agent);
    const win = this.attachWindow(tab, spec);
    await this.setViewport(tab.id, request);
    win.showInactive();
    this.emitState();
    if (url) await this.load(tab, normalizeAddress(url));
    return tab;
  }

  /** Close the device windows a chat spawned, when its session ends. */
  closeWindowsOf(agent: string): void {
    for (const tab of [...this.tabs.values()]) if (tab.win && tab.agent === agent) this.closeTab(tab.id);
  }

  /** Move a pane tab into a window sized to its viewport, or to the pane when it has none. */
  async popOut(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No browser tab ${id}`);
    if (tab.win) return;
    this.assertWindowSlot();
    const zoom = this.window.webContents.getZoomFactor();
    const { width, height } = this.layout.bounds;
    const spec =
      tab.viewport ?? resolveViewport({ width: width > 1 ? Math.round(width * zoom) : undefined, height: height > 1 ? Math.round(height * zoom) : undefined, source: "user" });
    if (this.attached === tab.view) this.detach();
    const win = this.attachWindow(tab, spec);
    if (this.paneId === id) {
      this.paneId = this.order.find((other) => other !== id && this.tabs.get(other)?.surface === "pane");
    }
    if (!tab.viewport) tab.autoViewport = true;
    await this.setViewport(id, { width: spec.width, height: spec.height, dpr: spec.dpr, mobile: spec.mobile, source: "user" });
    win.showInactive();
    this.applyLayout();
    this.emitState();
  }

  /** Move a window tab back into the pane and close its window. */
  async returnToPane(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No browser tab ${id}`);
    const win = tab.win;
    if (!win) return;
    tab.win = undefined;
    tab.surface = "pane";
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(tab.view);
      win.close();
    }
    if (tab.autoViewport) {
      tab.autoViewport = false;
      await this.setViewport(id, undefined);
    }
    this.activate(id);
  }

  /** Raise a window tab for the user; panes need nothing. */
  focusWindow(id: string): void {
    const win = this.tabs.get(id)?.win;
    if (win && !win.isDestroyed()) win.show();
  }

  private assertWindowSlot(): void {
    const open = [...this.tabs.values()].filter((tab) => tab.win).length;
    if (open >= WINDOW_LIMIT) throw new Error(`At most ${WINDOW_LIMIT} browser windows can be open; close one first`);
  }

  private attachWindow(tab: Tab, spec: ViewportSpec): BrowserWindow {
    const win = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      useContentSize: true,
      show: false,
      title: windowTitle(spec),
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
      fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.removeMenu();
    win.setAspectRatio(spec.width / spec.height);
    win.contentView.addChildView(tab.view);
    tab.win = win;
    tab.surface = win.id;
    win.on("resize", () => this.layoutWindow(tab));
    win.on("closed", () => {
      if (tab.win === win) this.closeTab(tab.id);
    });
    this.layoutWindow(tab);
    return win;
  }

  private layoutWindow(tab: Tab): void {
    const win = tab.win;
    if (!win || win.isDestroyed()) return;
    const [width = 0, height = 0] = win.getContentSize();
    const fit = this.fitFor(tab);
    tab.view.setBounds(fit ? { x: fit.bounds.x, y: fit.bounds.y, width: fit.bounds.width, height: fit.bounds.height } : { x: 0, y: 0, width, height });
    if (fit && tab.emulatedScale !== fit.scale) {
      tab.emulatedScale = fit.scale;
      void this.emulate(tab).catch((error) => log.warn("browser", `viewport apply failed: ${(error as Error).message}`));
    }
  }

  // ── Viewport ───────────────────────────────────────────────────────────────

  /** Set (request) or reset (undefined) a tab's emulated viewport. Throws on an unknown tab. */
  async setViewport(id: string, request: ViewportRequest | undefined): Promise<ViewportSpec | undefined> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No browser tab ${id}`);
    const before = tab.viewport;
    const spec = request ? resolveViewport(request) : undefined;
    tab.viewport = spec;
    tab.emulatedScale = undefined;
    // A window's content size follows its viewport, so the toolbar resizes the window.
    if (spec && tab.win && !tab.win.isDestroyed()) {
      tab.win.setAspectRatio(spec.width / spec.height);
      tab.win.setContentSize(spec.width, spec.height);
    }
    const wc = tab.view.webContents;
    await this.emulate(tab);
    if ((before?.userAgent ?? "native") !== (spec?.userAgent ?? "native") && wc.getURL()) wc.reload();
    this.layoutWindow(tab);
    this.applyLayout();
    this.emitState();
    return spec;
  }

  private reapply(tab: Tab): void {
    if (!tab.viewport || !this.tabs.has(tab.id)) return;
    tab.emulatedScale = undefined;
    void this.emulate(tab).catch((error) => log.warn("browser", `viewport re-apply failed: ${(error as Error).message}`));
  }

  /** Scale that fits the tab's viewport into the pane (window DIPs); 1 when nothing is emulated. */
  private fitFor(tab: Tab): ReturnType<typeof fitViewport> | undefined {
    if (!tab.viewport) return undefined;
    let pane: { width: number; height: number };
    if (tab.win && !tab.win.isDestroyed()) {
      const [width = 0, height = 0] = tab.win.getContentSize();
      pane = { width, height };
    } else {
      const zoom = this.window.webContents.getZoomFactor();
      pane = { width: Math.round(this.layout.bounds.width * zoom), height: Math.round(this.layout.bounds.height * zoom) };
    }
    return fitViewport(pane.width > 1 && pane.height > 1 ? pane : { width: tab.viewport.width, height: tab.viewport.height }, tab.viewport);
  }

  /** Send the tab's whole emulation (metrics, touch, UA) over CDP, or clear it. */
  private async emulate(tab: Tab): Promise<void> {
    const wc = tab.view.webContents;
    const spec = tab.viewport;
    if (!spec) {
      this.hintHeaders.delete(wc.id);
      if (!wc.debugger.isAttached()) return;
      await cdp(wc, "Emulation.clearDeviceMetricsOverride");
      await cdp(wc, "Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp(wc, "Emulation.setEmitTouchEventsForMouse", { enabled: false });
      await cdp(wc, "Emulation.setUserAgentOverride", { userAgent: "" });
      return;
    }
    // Device metrics on a view that never navigated crash Electron 44 on macOS (null dereference in the main process).
    if (!wc.getURL()) await this.load(tab, "about:blank");
    const scale = this.fitFor(tab)?.scale ?? 1;
    tab.emulatedScale = scale;
    await cdp(wc, "Emulation.setDeviceMetricsOverride", {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.dpr,
      mobile: spec.mobile,
      screenWidth: spec.width,
      screenHeight: spec.height,
      scale,
    });
    await cdp(wc, "Emulation.setTouchEmulationEnabled", { enabled: spec.touch, maxTouchPoints: 5 });
    await cdp(wc, "Emulation.setEmitTouchEventsForMouse", { enabled: spec.touch, configuration: "mobile" });
    const ua = userAgentFor(spec.userAgent, process.versions.chrome);
    if (ua) {
      this.hintHeaders.set(wc.id, ua.headers);
      await cdp(wc, "Emulation.setUserAgentOverride", { userAgent: ua.userAgent, platform: ua.platform, userAgentMetadata: ua.metadata });
    } else {
      this.hintHeaders.delete(wc.id);
      await cdp(wc, "Emulation.setUserAgentOverride", { userAgent: "" });
    }
  }

  // ── Layout ─────────────────────────────────────────────────────────────────

  setLayout(layout: BrowserLayout): void {
    this.layout = layout;
    this.applyLayout();
    if (layout.visible) {
      for (const resolve of this.visibleWaiters.splice(0)) resolve();
    }
  }

  private applyLayout(): void {
    // While the addressed tab lives in a window the pane shows a DOM placeholder, so no native view may cover it.
    const tab = this.paneId && (this.active()?.surface ?? "pane") === "pane" ? this.tabs.get(this.paneId) : undefined;
    if (!this.layout.visible || !tab || this.layout.bounds.width < 2) {
      this.detach();
      return;
    }
    if (this.attached !== tab.view) {
      this.detach();
      this.window.contentView.addChildView(tab.view);
      this.attached = tab.view;
    }
    // Renderer bounds are CSS pixels; scale by the app's zoom to get window DIPs.
    const zoom = this.window.webContents.getZoomFactor();
    const { x, y, width, height } = this.layout.bounds;
    const pane = { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) };
    const fit = this.fitFor(tab);
    if (!fit) {
      tab.view.setBounds(pane);
      return;
    }
    // Emulated viewports are scaled down to fit and centred in the pane.
    tab.view.setBounds({ x: pane.x + fit.bounds.x, y: pane.y + fit.bounds.y, width: fit.bounds.width, height: fit.bounds.height });
    if (tab.emulatedScale !== fit.scale) {
      tab.emulatedScale = fit.scale;
      void this.emulate(tab).catch((error) => log.warn("browser", `viewport apply failed: ${(error as Error).message}`));
    }
  }

  private detach(): void {
    if (this.attached) this.window.contentView.removeChildView(this.attached);
    this.attached = undefined;
  }

  /** Make sure a tab is drawn before the agent screenshots or clicks it. */
  async ensureVisible(tab: Tab): Promise<void> {
    if (this.activeId !== tab.id) this.activate(tab.id);
    if (tab.win) {
      // A window tab never reveals the pane; a minimized window cannot be captured.
      if (!tab.win.isDestroyed() && tab.win.isMinimized()) tab.win.restore();
      return;
    }
    if (this.layout.visible) return;
    this.events.reveal();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      this.visibleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── Annotations ────────────────────────────────────────────────────────────

  setAnnotating(on: boolean): void {
    if (this.annotating === on) return;
    this.annotating = on;
    this.annotateGeneration++;
    const tab = this.active();
    if (on && tab) {
      tab.view.webContents.focus();
      void this.annotateLoop();
    } else if (tab) {
      void tab.view.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: STOP_ANNOTATE }]).catch(() => undefined);
    }
    this.emitState();
  }

  /** Keeps a picker running on the active tab until annotation mode ends; restarts after navigation. */
  private async annotateLoop(): Promise<void> {
    const generation = ++this.annotateGeneration;
    while (this.annotating && generation === this.annotateGeneration) {
      const tab = this.active();
      if (!tab) return;
      type Picked = Omit<Annotation, "id" | "image"> & { rect: { x: number; y: number; width: number; height: number } };
      let picked: Picked | undefined;
      try {
        picked = await tab.view.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: ANNOTATE }], true);
      } catch {
        return; // page navigated away; did-navigate restarts the loop
      }
      if (generation !== this.annotateGeneration) return;
      if (!picked) {
        this.annotating = false; // Esc in the page ends annotation mode
        this.emitState();
        return;
      }
      const { rect, ...rest } = picked;
      const pad = 12;
      const crop = await tab.view.webContents
        .capturePage({
          x: Math.max(0, Math.round(rect.x - pad)),
          y: Math.max(0, Math.round(rect.y - pad)),
          width: Math.max(1, Math.round(rect.width + pad * 2)),
          height: Math.max(1, Math.round(Math.min(rect.height, 600) + pad * 2)),
        })
        .catch(() => undefined);
      const image = crop && !crop.isEmpty() ? (crop.getSize().width > 800 ? crop.resize({ width: 800 }) : crop).toJPEG(80).toString("base64") : undefined;
      this.events.annotation({ ...rest, id: randomUUID().slice(0, 8), image });
      log.info("browser", `annotation on ${rest.url}: ${rest.label}`);
    }
  }

  destroy(): void {
    for (const id of [...this.order]) this.closeTab(id);
  }
}

function windowTitle(spec: ViewportSpec): string {
  return `${spec.label} ${spec.width}x${spec.height} @${spec.dpr}x`;
}
