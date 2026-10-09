// Browser tabs: one WebContentsView per tab in a persistent profile separate from the app.
// The renderer owns layout (where the pane is); main owns pages, history and annotations.
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, nativeImage, session, shell, WebContentsView, type WebContents } from "electron";
import {
  type Annotation,
  type BrowserCommand,
  type BrowserLayout,
  type BrowserState,
  type HistoryEntry,
  normalizeAddress,
} from "../../shared/browser";
import { parsePreviewUrl, PREVIEW_SCHEME, previewFor, previewLabel, previewUrl, type PreviewMode, type PreviewOpenOptions, type TabPreview } from "../../shared/preview";
import { fitViewport, resolveViewport, userAgentFor, type ViewportRequest, type ViewportSpec } from "../../shared/viewport";
import { attachContextMenu } from "../context-menu";
import { log } from "../log";
import { cdp } from "./cdp";
import { IconCache, tabFavicon, type TabIcon } from "./favicon";
import { previewContext, type SourceHint } from "./annotation-source";
import { ANNOTATE, ISOLATED_WORLD, STOP_ANNOTATE } from "./page-scripts";
import { previews } from "./preview-protocol";
import { isRunnable, needsReload, previewRoot, relativeTo, reusableTab, watchFile } from "./preview-tabs";

export const PARTITION = "persist:pigna-browser";
const CONSOLE_LIMIT = 300;
const HISTORY_LIMIT = 500;
/** A pane still is reused this long unless the page loads, navigates, takes input or is driven first, or the pane moves:
 * a repaint no event reports (an animation, a dev server's hot reload) leaves it at most this old. */
const STILL_MAX_AGE_MS = 3000;
/** Standalone device windows open at once. */
export const WINDOW_LIMIT = 4;

export interface ConsoleEntry {
  level: string;
  message: string;
  source: string;
  at: number;
}

/** What a preview tab serves: the file behind its pigna-file URL, kept live by a watcher. */
interface PreviewState {
  info: TabPreview;
  token: string;
  root: string;
  /** Path of the file below `root`. */
  relative: string;
  stop: () => void;
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
  /** Id of the Kanban card this tab shows; its page is blank, the renderer draws the card. */
  card?: string;
  /** A new tab with nothing loaded yet; the renderer draws the start page. Cleared by `load`. */
  start?: boolean;
  /** The viewport was made up when popping out a tab that had none; returning to the pane drops it again. */
  autoViewport?: boolean;
  /** Remote viewers watching this tab: while any, the view stays in the window tree (see `hold`). */
  holds: number;
  /** When the agent last drove the tab; shown to clients as "agent is using this". */
  agentAt?: number;
  /** Set while the tab shows a local file; web tabs have none. */
  preview?: PreviewState;
  /** The page's icon, and the origin it belongs to (a navigation elsewhere drops it). */
  favicon?: TabIcon & { origin: string };
  /** Bumped per favicon request, so a slow one for an earlier page cannot win. */
  faviconSeq?: number;
}

/** Electron decodes the bitmap (PNG, JPEG; ICO where the platform can) and shrinks it for the tab strip. */
const shrinkIcon = (bytes: Buffer, size: number): string | null => {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width } = image.getSize();
  return (width > size ? image.resize({ width: size, height: size, quality: "best" }) : image).toDataURL();
};

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** Size a viewer-held tab without a viewport is laid out at while parked. */
const PARK_SIZE = { width: 1280, height: 800 };

export interface BrowserEvents {
  state(state: BrowserState): void;
  /** Ask the renderer to show the pane (the agent is about to use it). */
  reveal(chat?: string): void;
  /** `send`: the user chose Send in the picker, so the chat sends it (and any other waiting comments) now. */
  annotation(annotation: Annotation, send: boolean): void;
}

export class BrowserManager {
  readonly tabs = new Map<string, Tab>();
  private order: string[] = [];
  /** The tab the agent and toolbar address; may live in a window. */
  private activeId?: string;
  /** The pane tab that is drawn in the pane. */
  private paneId?: string;
  /** The chat on screen. Tabs belong to chats: only this chat's tabs are addressed by the toolbar and drawn in the pane. */
  private chat?: string;
  /** Each chat's last addressed tab, restored when it comes back on screen. */
  private readonly recent = new Map<string, string>();
  private layout: BrowserLayout = { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  private attached?: WebContentsView;
  /** Views of tabs held for remote viewers that are not in the pane or a window; they sit in the keeper window. */
  private readonly parked = new Set<WebContentsView>();
  private keeper?: BrowserWindow;
  private annotating = false;
  private annotateGeneration = 0;
  private stateTimer?: ReturnType<typeof setTimeout>;
  /** The state last published, serialized: an unchanged one is not sent again. */
  private published?: string;
  private readonly icons = new IconCache();
  /** The pane's last still while it may be reused (see `still`). */
  private stillCache?: { view: WebContentsView; bounds: string; at: number; image: Promise<string | undefined> };
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
      this.keeper?.destroy();
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
    const previewedBy = (owner?: string) => [...this.tabs.values()].flatMap((tab) => (tab.preview && tab.agent === owner ? [tab.preview.info.path] : []));
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
            title: tab.preview ? previewLabel(tab.preview.info.path, previewedBy(tab.agent)) : wc.getTitle(),
            loading: wc.isLoading(),
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
            agent: tab.agent,
            viewport: tab.viewport,
            surface: tab.win ? ("window" as const) : ("pane" as const),
            agentAt: tab.agentAt,
            preview: tab.preview?.info,
            card: tab.card,
            start: tab.start,
            faviconKey: tab.preview || tab.card || tab.favicon?.origin !== originOf(wc.getURL()) ? undefined : tab.favicon?.key,
          },
        ];
      }),
    };
  }

  private emitState(): void {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      const state = this.snapshot();
      const serialized = JSON.stringify(state);
      if (serialized === this.published) return;
      this.published = serialized;
      this.events.state(state);
    }, 30);
  }

  /** The data URL of the icon a tab's `faviconKey` names, while a tab shows it. */
  favicon(key: string): string | null {
    for (const tab of this.tabs.values()) if (tab.favicon?.key === key) return tab.favicon.url;
    return null;
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
    const tab: Tab = { id: randomUUID().slice(0, 8), view, console: [], agent: agent ?? this.chat, surface: "pane", holds: 0 };
    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);
    this.wire(tab);
    return tab;
  }

  /** Opens a tab on `url`, or without one a start tab, which the renderer draws as a launcher until something loads. */
  createTab(url?: string, agent?: string): Tab {
    const tab = this.makeTab(agent);
    if (!url) tab.start = true;
    this.activate(tab.id);
    if (url) void this.load(tab, url);
    return tab;
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const changed = () => {
      this.staleStill(tab);
      this.emitState();
    };
    wc.on("did-start-loading", changed);
    wc.on("did-stop-loading", changed);
    wc.on("page-title-updated", changed);
    wc.on("did-navigate-in-page", changed);
    // Clicks, keys and wheel scrolls repaint the page under the pane's still.
    wc.on("input-event", () => this.staleStill(tab));
    wc.on("page-favicon-updated", (_event, favicons) => void this.loadFavicon(tab, favicons));
    wc.on("did-navigate", (_event, url) => {
      if (tab.favicon && tab.favicon.origin !== originOf(url)) tab.favicon = undefined;
      changed();
      this.syncPreview(tab, url);
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
    // A web page must never reach local files through pigna-file: only a preview tab may open links on that scheme.
    const previewGate = (url: string): boolean => url.startsWith(`${PREVIEW_SCHEME}:`) && !wc.getURL().startsWith(`${PREVIEW_SCHEME}:`);
    wc.setWindowOpenHandler(({ url }) => {
      if (previewGate(url)) return { action: "deny" };
      this.createTab(url, tab.agent);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (previewGate(url) || !/^(https?|file|about|data|blob|pigna-file):/i.test(url)) event.preventDefault();
    });
    attachContextMenu(wc, { page: true, openTab: (url) => this.createTab(url, tab.agent) });
  }

  private async loadFavicon(tab: Tab, favicons: string[]): Promise<void> {
    const wc = tab.view.webContents;
    const page = wc.getURL();
    if (!/^https?:/i.test(page)) return;
    const seq = (tab.faviconSeq ?? 0) + 1;
    tab.faviconSeq = seq;
    const origin = originOf(page);
    const icon = await this.icons.get(origin, favicons, () => tabFavicon(page, favicons, (input, init) => wc.session.fetch(input as string, init), shrinkIcon).catch(() => null));
    if (tab.faviconSeq !== seq || wc.isDestroyed()) return;
    tab.favicon = icon ? { ...icon, origin } : undefined;
    this.emitState();
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
    // The tab's neighbours among its own chat's tabs take over when it was the one shown.
    const siblings = this.order.filter((other) => this.tabs.get(other)?.agent === tab.agent && other !== id);
    const index = this.order.filter((other) => this.tabs.get(other)?.agent === tab.agent).indexOf(id);
    this.order.splice(this.order.indexOf(id), 1);
    if (tab.agent && this.recent.get(tab.agent) === id) this.recent.delete(tab.agent);
    this.tabs.delete(id);
    this.hintHeaders.delete(tab.view.webContents.id);
    if (tab.preview) this.dropPreview(tab.preview);
    tab.preview = undefined;
    if (this.attached === tab.view) this.detach();
    this.unpark(tab);
    // The tab is already gone, so the window's "closed" handler finds nothing to do.
    if (tab.win && !tab.win.isDestroyed()) tab.win.close();
    tab.view.webContents.close();
    if (this.paneId === id) {
      this.paneId = undefined;
      const next = [siblings[index], siblings[index - 1]].find((candidate) => candidate && this.tabs.get(candidate)?.surface === "pane");
      if (next) this.paneId = next;
    }
    if (this.activeId === id) {
      this.activeId = undefined;
      const next = siblings[index] ?? siblings[index - 1];
      if (next) this.activate(next);
    }
    this.applyLayout();
    this.emitState();
  }

  /** Put a chat on screen: its tabs, and the one it last addressed, replace the previous chat's. */
  focus(chat?: string): void {
    if (this.chat === chat) return;
    if (this.annotating) this.setAnnotating(false);
    this.chat = chat;
    const mine = this.order.filter((id) => this.tabs.get(id)?.agent === chat);
    const remembered = chat ? this.recent.get(chat) : undefined;
    const pane = (id: string) => this.tabs.get(id)?.surface === "pane";
    const next = remembered && mine.includes(remembered) ? remembered : (mine.find(pane) ?? mine[0]);
    this.activeId = next;
    this.paneId = next && pane(next) ? next : mine.find(pane);
    this.applyLayout();
    this.emitState();
  }

  activate(id: string): void {
    const target = this.tabs.get(id);
    if (!target) return;
    if (target.agent) this.recent.set(target.agent, id);
    // A tab of a chat that is not on screen is only remembered: it must not replace what is drawn.
    if (target.agent !== this.chat) return;
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
    if (tab.start) {
      tab.start = undefined;
      this.emitState();
    }
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      const message = (error as Error).message;
      if (!message.includes("ERR_ABORTED")) throw error;
    }
  }

  // ── Previews ────────────────────────────────────────────────────────────────

  /**
   * Show a local file in a tab next to the web tabs. An open preview of the same file is reused unless `newTab`.
   * `options.root` is the project directory: files inside it share one origin. Rejects for missing paths and directories.
   */
  async openPreview(path: string, options: PreviewOpenOptions = {}): Promise<Tab> {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("A preview needs an absolute path");
    const file = await realpath(path).catch(() => {
      throw new Error(`No such file: ${path}`);
    });
    if (!(await stat(file)).isFile()) throw new Error(`${path} is not a file`);
    const project = options.root ? await realpath(options.root).catch(() => undefined) : undefined;
    const root = previewRoot(file, project);
    // A chat reuses only its own previews: another chat's tab of the same file stays that chat's.
    const owner = options.agent ?? this.chat;
    const into = options.into ? this.tabs.get(options.into) : undefined;
    if (options.into && !into?.start) throw new Error(`Browser tab ${options.into} is not a new tab`);
    const reuse = into || options.newTab ? undefined : reusableTab([...this.tabs.values()].filter((tab) => tab.agent === owner).map((tab) => ({ id: tab.id, path: tab.preview?.info.path })), file);
    const reused = reuse ? this.tabs.get(reuse) : undefined;
    const tab = into ?? reused ?? this.makeTab(owner);
    const defaults = previewFor(file);
    const mode = options.mode && defaults.modes.includes(options.mode) ? options.mode : defaults.mode;
    const shown = reused?.preview?.info.mode;
    if (!shown || needsReload(shown, mode, options.line, tab.view.webContents.isCrashed())) this.startPreview(tab, file, root, mode, options.line);
    this.activate(tab.id);
    if (!tab.win) this.events.reveal(tab.agent);
    return tab;
  }

  /** Show a Kanban card in a tab next to the previews. A chat reuses its own tab of the same card. */
  openCard(card: string, agent?: string): Tab {
    const owner = agent ?? this.chat;
    const tab = [...this.tabs.values()].find((other) => other.card === card && other.agent === owner) ?? this.makeTab(owner);
    tab.card = card;
    this.activate(tab.id);
    if (!tab.win) this.events.reveal(tab.agent);
    this.emitState();
    return tab;
  }

  /** Switch a preview tab between its rendered and raw (source) view. */
  setPreviewMode(id: string, mode: PreviewMode): void {
    const tab = this.tabs.get(id);
    const state = tab?.preview;
    if (!tab || !state) throw new Error(`Browser tab ${id} is not a file preview`);
    if (!state.info.modes.includes(mode)) throw new Error(`${state.info.name} has no ${mode} view`);
    state.info.mode = mode;
    void this.load(tab, previewUrl(state.token, state.relative, mode === "raw" ? "raw" : undefined));
    this.emitState();
  }

  /** Show the previewed file in Finder. */
  revealPreview(id: string): void {
    const path = this.tabs.get(id)?.preview?.info.path;
    if (!path) throw new Error(`Browser tab ${id} is not a file preview`);
    shell.showItemInFolder(path);
  }

  /** Open the previewed file with its default app; programs are refused. */
  async openPreviewExternally(id: string): Promise<void> {
    const path = this.tabs.get(id)?.preview?.info.path;
    if (!path) throw new Error(`Browser tab ${id} is not a file preview`);
    if (isRunnable(path, (await stat(path)).mode)) throw new Error("Programs are not opened from a preview");
    const failure = await shell.openPath(path);
    if (failure) throw new Error(failure);
  }

  private startPreview(tab: Tab, file: string, root: string, mode: PreviewMode, line?: number): void {
    const old = tab.preview;
    const relative = relativeTo(root, file);
    const token = previews.mint(root, relative);
    const wc = tab.view.webContents;
    tab.preview = {
      info: { ...previewFor(file), mode },
      token,
      root,
      relative,
      stop: watchFile(file, () => {
        if (!wc.isDestroyed()) void stat(file).then(() => wc.reload(), () => undefined);
      }),
    };
    if (old) this.dropPreview(old);
    const hash = line && Number.isInteger(line) && line > 0 ? `#L${line}` : "";
    void this.load(tab, previewUrl(token, relative, mode === "raw" ? "raw" : undefined) + hash);
    this.emitState();
  }

  /** Stop watching, and revoke the token once no other tab uses it. */
  private dropPreview(state: PreviewState): void {
    state.stop();
    if (![...this.tabs.values()].some((tab) => tab.preview?.token === state.token)) previews.revoke(state.token);
  }

  /** Keep preview state true to where the tab is: another file of the same root follows the link, anything else ends the preview. */
  private syncPreview(tab: Tab, url: string): void {
    const state = tab.preview;
    if (!state) return;
    const parsed = parsePreviewUrl(url);
    if (!parsed || parsed.token !== state.token) {
      tab.preview = undefined;
      this.dropPreview(state);
      return;
    }
    const file = join(state.root, parsed.relative);
    const next = previewFor(file);
    const wanted: PreviewMode = parsed.view === "raw" || parsed.view === "source" ? "raw" : "rendered";
    const mode = next.modes.includes(wanted) ? wanted : next.mode;
    if (parsed.relative === state.relative) {
      state.info.mode = mode;
      return;
    }
    state.stop();
    const wc = tab.view.webContents;
    tab.preview = {
      ...state,
      relative: parsed.relative,
      info: { ...next, mode },
      stop: watchFile(file, () => {
        if (!wc.isDestroyed()) void stat(file).then(() => wc.reload(), () => undefined);
      }),
    };
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
    if (url) {
      // A window whose page failed to load would hold a slot the caller never learned the id of.
      try {
        await this.load(tab, normalizeAddress(url));
      } catch (error) {
        this.closeTab(tab.id);
        throw error;
      }
    }
    return tab;
  }

  /** Close a chat's tabs and device windows, when its session ends. */
  closeTabsOf(chat: string): void {
    for (const tab of [...this.tabs.values()]) if (tab.agent === chat) this.closeTab(tab.id);
    this.recent.delete(chat);
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
      this.paneId = this.order.find((other) => other !== id && this.tabs.get(other)?.agent === tab.agent && this.tabs.get(other)?.surface === "pane");
    }
    // An existing viewport moves as is (attachWindow re-emulates it at the window's fit); re-resolving it from its
    // numbers would drop the device label and re-derive the user agent (a Pixel would turn into an iPhone).
    if (!tab.viewport) {
      tab.autoViewport = true;
      await this.setViewport(id, { width: spec.width, height: spec.height, source: "user" });
    }
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
    // A window's content size follows its viewport, so the toolbar resizes the window; Reset keeps its size.
    if (tab.win && !tab.win.isDestroyed()) {
      if (spec) {
        tab.win.setAspectRatio(spec.width / spec.height);
        tab.win.setContentSize(spec.width, spec.height);
      }
      tab.win.setTitle(spec ? windowTitle(spec) : "Responsive");
    }
    const wc = tab.view.webContents;
    await this.emulate(tab);
    // A new User-Agent needs a reload; wait for it, so a screenshot right after does not catch the page half-loaded.
    if ((before?.userAgent ?? "native") !== (spec?.userAgent ?? "native") && wc.getURL()) await reload(wc);
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
    if (this.parked.has(tab.view)) {
      pane = { width: tab.viewport.width, height: tab.viewport.height };
    } else if (tab.win && !tab.win.isDestroyed()) {
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
    // Without dontSetVisibleSize Chromium resizes the view's surface to the unscaled emulated size, which spills past
    // the fitted bounds as a blank area until the next real setBounds; the view's size is ours to set.
    await cdp(wc, "Emulation.setDeviceMetricsOverride", {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.dpr,
      mobile: spec.mobile,
      screenWidth: spec.width,
      screenHeight: spec.height,
      scale,
      dontSetVisibleSize: true,
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
    this.applyPane();
    this.syncParked();
  }

  private applyPane(): void {
    // While the addressed tab lives in a window the pane shows a DOM placeholder, so no native view may cover it.
    const tab = this.paneId && (this.active()?.surface ?? "pane") === "pane" ? this.tabs.get(this.paneId) : undefined;
    if (!this.layout.visible || !tab || this.layout.bounds.width < 2) {
      this.detach();
      return;
    }
    if (this.attached !== tab.view) {
      this.detach();
      this.parked.delete(tab.view);
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

  /**
   * A still of the page drawn in the pane, which the renderer shows in its place while a DOM overlay hides it. Overlays
   * come and go over the same picture, so a still is reused until the page loads, navigates, takes input or is driven,
   * the pane moves, or it is STILL_MAX_AGE_MS old.
   */
  still(): Promise<string | undefined> {
    const view = this.attached;
    if (!view) return Promise.resolve(undefined);
    const bounds = JSON.stringify(view.getBounds());
    const cached = this.stillCache;
    if (cached?.view === view && cached.bounds === bounds && Date.now() - cached.at < STILL_MAX_AGE_MS) return cached.image;
    const image = view.webContents.capturePage().then(
      (shot) => (shot.isEmpty() ? undefined : `data:image/jpeg;base64,${shot.toJPEG(75).toString("base64")}`),
      () => undefined,
    );
    const entry = { view, bounds, at: Date.now(), image };
    this.stillCache = entry;
    // A failed capture is not reused.
    void image.then((still) => {
      if (!still && this.stillCache === entry) this.stillCache = undefined;
    });
    return image;
  }

  /** The page may look different now (the agent or a phone just acted on it): the pane's still of it is not reused. */
  staleStill(tab: Tab): void {
    if (this.stillCache?.view === tab.view) this.stillCache = undefined;
  }

  private detach(): void {
    if (this.attached) this.window.contentView.removeChildView(this.attached);
    this.attached = undefined;
  }

  // ── Remote viewers ─────────────────────────────────────────────────────────

  /**
   * Keep a tab rendering while a remote viewer watches it, whatever the desktop shows. A view outside any window
   * stops rendering and answering touch (docs/REMOTE_BROWSER_SPIKE.md), and one added to the app window while that is
   * hidden never starts (scripts/remote-browser-park.mjs), so a tab that is not in the pane or a window is parked in
   * the keeper: an invisible, click-through, unfocusable window that counts as shown (opacity 0) and holds the view
   * at its full size. Offscreen or 1x1 rects do not hit-test. The pane is never revealed for this; call `release`
   * when the viewer leaves.
   */
  hold(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No browser tab ${id}`);
    tab.holds++;
    this.syncParked();
    return tab;
  }

  release(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.holds === 0) return;
    tab.holds--;
    this.syncParked();
  }

  /** The agent just acted on a tab. */
  markAgent(tab: Tab): void {
    tab.agentAt = Date.now();
    this.emitState();
  }

  private syncParked(): void {
    for (const tab of this.tabs.values()) {
      if (tab.holds > 0 && !tab.win && this.attached !== tab.view) this.park(tab);
      else this.unpark(tab);
    }
  }

  private park(tab: Tab): void {
    const size = tab.viewport ?? PARK_SIZE;
    const keeper = this.keeperWindow(size);
    if (!this.parked.has(tab.view)) {
      keeper.contentView.addChildView(tab.view);
      this.parked.add(tab.view);
    }
    tab.view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
    // Parked views are not scaled to a pane.
    if (tab.viewport && tab.emulatedScale !== 1) {
      tab.emulatedScale = 1;
      void this.emulate(tab).catch((error) => log.warn("browser", `viewport apply failed: ${(error as Error).message}`));
    }
  }

  private unpark(tab: Tab): void {
    if (!this.parked.delete(tab.view)) return;
    // The pane or a window may have taken the view over already.
    if (this.keeper && !this.keeper.isDestroyed() && this.keeper.contentView.children.includes(tab.view)) this.keeper.contentView.removeChildView(tab.view);
    // Back in the pane or a window the fit is recomputed there.
    tab.emulatedScale = undefined;
    if (!this.parked.size) {
      this.keeper?.destroy();
      this.keeper = undefined;
    }
  }

  private keeperWindow(size: { width: number; height: number }): BrowserWindow {
    if (this.keeper && !this.keeper.isDestroyed()) {
      const [width = 0, height = 0] = this.keeper.getContentSize();
      if (width < size.width || height < size.height) this.keeper.setContentSize(Math.max(width, size.width), Math.max(height, size.height));
      return this.keeper;
    }
    const keeper = new BrowserWindow({
      width: size.width,
      height: size.height,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    keeper.setOpacity(0);
    keeper.setIgnoreMouseEvents(true);
    keeper.showInactive();
    keeper.on("closed", () => {
      if (this.keeper === keeper) this.keeper = undefined;
      this.parked.clear();
    });
    this.keeper = keeper;
    return keeper;
  }

  /** Make sure a tab is drawn before the agent screenshots or clicks it. */
  async ensureVisible(tab: Tab): Promise<void> {
    if (this.activeId !== tab.id) this.activate(tab.id);
    if (tab.win) {
      // A window tab never reveals the pane; a minimized window cannot be captured.
      if (!tab.win.isDestroyed() && tab.win.isMinimized()) tab.win.restore();
      return;
    }
    // Another chat's pane is not drawn now; opening it for that chat is all there is to do.
    if (tab.agent !== this.chat) {
      this.events.reveal(tab.agent);
      return;
    }
    if (this.layout.visible) return;
    this.events.reveal(tab.agent);
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
      type Picked = Omit<Annotation, "id" | "image"> & { rect: { x: number; y: number; width: number; height: number }; source?: SourceHint; send?: boolean };
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
      const { rect, source, send, line, ...rest } = picked;
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
      const where = await previewContext(tab.preview?.info, line, source);
      this.events.annotation({ ...rest, ...where, id: randomUUID().slice(0, 8), image, chat: tab.agent }, send === true);
      log.info("browser", `annotation on ${where.file ?? rest.url}: ${rest.label}${send ? " (send)" : ""}`);
    }
  }

  destroy(): void {
    for (const id of [...this.order]) this.closeTab(id);
  }
}

/** Reload and resolve when loading stopped (or after 15 s). */
function reload(wc: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wc.off("did-stop-loading", done);
      resolve();
    };
    const timer = setTimeout(done, 15_000);
    wc.on("did-stop-loading", done);
    wc.reload();
  });
}

function windowTitle(spec: ViewportSpec): string {
  return `${spec.label} ${spec.width}x${spec.height} @${spec.dpr}x`;
}
