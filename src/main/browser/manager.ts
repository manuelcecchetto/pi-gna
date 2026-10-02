// Browser tabs: one WebContentsView per tab in a persistent profile separate from the app.
// The renderer owns layout (where the pane is); main owns pages, history and annotations.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow, session, WebContentsView, type WebContents } from "electron";
import {
  type Annotation,
  type BrowserCommand,
  type BrowserLayout,
  type BrowserState,
  type HistoryEntry,
  normalizeAddress,
} from "../../shared/browser";
import { log } from "../log";
import { ANNOTATE, ISOLATED_WORLD, STOP_ANNOTATE } from "./page-scripts";

export const PARTITION = "persist:pigna-browser";
const CONSOLE_LIMIT = 300;
const HISTORY_LIMIT = 500;

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
  private activeId?: string;
  private layout: BrowserLayout = { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  private attached?: WebContentsView;
  private annotating = false;
  private annotateGeneration = 0;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private visibleWaiters: (() => void)[] = [];
  private history: HistoryEntry[] = [];
  private historyTimer?: ReturnType<typeof setTimeout>;
  private readonly historyPath = join(app.getPath("userData"), "browser-history.json");

  constructor(
    private readonly window: BrowserWindow,
    private readonly events: BrowserEvents,
  ) {
    const profile = session.fromPartition(PARTITION);
    // Pages get no camera, microphone, location or notifications.
    profile.setPermissionRequestHandler((_wc, permission, callback) => callback(["clipboard-sanitized-write", "fullscreen"].includes(permission)));
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

  createTab(url?: string, agent?: string): Tab {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    view.setBackgroundColor("#ffffff");
    const tab: Tab = { id: randomUUID().slice(0, 8), view, console: [], agent };
    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);
    this.wire(tab);
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
    wc.on("render-process-gone", (_event, details) => this.pushConsole(tab, "error", `Page crashed: ${details.reason}`, "browser"));
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
    if (this.attached === tab.view) this.detach();
    tab.view.webContents.close();
    if (this.activeId === id) {
      this.activeId = undefined;
      const next = this.order[index] ?? this.order[index - 1];
      if (next) this.activate(next);
    }
    this.emitState();
  }

  activate(id: string): void {
    if (!this.tabs.has(id)) return;
    if (this.annotating && this.activeId !== id) this.setAnnotating(false);
    this.activeId = id;
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

  // ── Layout ─────────────────────────────────────────────────────────────────

  setLayout(layout: BrowserLayout): void {
    this.layout = layout;
    this.applyLayout();
    if (layout.visible) {
      for (const resolve of this.visibleWaiters.splice(0)) resolve();
    }
  }

  private applyLayout(): void {
    const tab = this.active();
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
    tab.view.setBounds({ x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) });
  }

  private detach(): void {
    if (this.attached) this.window.contentView.removeChildView(this.attached);
    this.attached = undefined;
  }

  /** Make sure a tab is drawn before the agent screenshots or clicks it. */
  async ensureVisible(tab: Tab): Promise<void> {
    if (this.activeId !== tab.id) this.activate(tab.id);
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
