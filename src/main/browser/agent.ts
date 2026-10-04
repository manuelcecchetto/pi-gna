// Agent browser actions behind the browser_* tools. Each pi session drives its own tab. Input and
// screenshots go through CDP (webContents.debugger): OS-level input and capturePage need composited
// frames, which Chromium stops producing while the app window is hidden behind other windows.
import { nativeImage, type WebContents } from "electron";
import { type AgentAction, type AgentResult, normalizeAddress, screenshotSize } from "../../shared/browser";
import { resolveViewport } from "../../shared/viewport";
import { bridgeError, type Route } from "../bridge";
import { log } from "../log";
import { cdp } from "./cdp";
import type { BrowserManager, Tab } from "./manager";
import { focusForTyping, ISOLATED_WORLD, locate, SNAPSHOT } from "./page-scripts";

const TEXT_LIMIT = 20_000;
const SCREENSHOT_LONG_EDGE = 1600;
interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}
const KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
};
const MODIFIER_BITS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

function keyDef(name: string): KeyDef {
  const known = KEYS[name.toLowerCase()];
  if (known) return known;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : "";
    return { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  throw new Error(`Unknown key "${name}". Use names like Enter, Tab, Escape, ArrowDown, PageDown or a single character.`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ACTIONS = new Set(["open", "snapshot", "click", "type", "press", "screenshot", "evaluate", "console", "back", "state", "viewport"]);

/** POST /browser on the agent bridge: the browser_* tools. */
export function browserRoute(agent: () => BrowserAgent | undefined): Route {
  return async (handle, body) => {
    const action = body as AgentAction;
    if (!ACTIONS.has(action?.action)) throw bridgeError(400, `unknown action ${String(action?.action)}`);
    const current = agent();
    if (!current) throw bridgeError(503, "the browser is not ready");
    return current.run(handle, action);
  };
}

export class BrowserAgent {
  /** Per-session queue: pi runs one message's tool calls in parallel, but a page is sequential. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly browser: BrowserManager) {}

  run(handle: string, request: AgentAction): Promise<AgentResult> {
    const previous = this.queues.get(handle) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.perform(handle, request));
    this.queues.set(handle, next);
    void next.finally(() => {
      if (this.queues.get(handle) === next) this.queues.delete(handle);
    }).catch(() => undefined);
    return next;
  }

  /** Every result carries the tab's viewport, so a size the user changed is visible to the agent. */
  private async perform(handle: string, request: AgentAction): Promise<AgentResult> {
    const result = await this.dispatch(handle, request);
    if (result.viewport) return result;
    const viewport = this.agentTab(handle)?.viewport;
    return viewport ? { ...result, viewport } : result;
  }

  private async dispatch(handle: string, request: AgentAction): Promise<AgentResult> {
    if (request.action === "open") return this.open(handle, request.url, request.newTab ?? false);
    const tab = this.tabFor(handle);
    const wc = tab.view.webContents;
    log.info("browser", `${handle.slice(0, 4)} ${request.action}${"ref" in request ? ` [${request.ref}]` : ""}`);
    switch (request.action) {
      case "snapshot":
        await this.browser.ensureVisible(tab);
        return this.snapshot(wc);
      case "click": {
        await this.browser.ensureVisible(tab);
        const point = await this.exec<{ x: number; y: number } | null>(wc, locate(request.ref));
        if (!point) throw new Error(`No element [${request.ref}] on the page. Take a new browser_snapshot first.`);
        await delay(60); // let scrollIntoView settle
        const before = wc.getURL();
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await cdp(wc, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
        }
        return this.afterAction(wc, `Clicked [${request.ref}].`, before);
      }
      case "type": {
        await this.browser.ensureVisible(tab);
        const ok = await this.exec<boolean>(wc, focusForTyping(request.ref, request.clear ?? true));
        if (!ok) throw new Error(`No element [${request.ref}] on the page. Take a new browser_snapshot first.`);
        const before = wc.getURL();
        await cdp(wc, "Input.insertText", { text: request.text });
        if (request.submit) await this.key(wc, "Enter");
        return this.afterAction(wc, `Typed into [${request.ref}]${request.submit ? " and pressed Enter" : ""}.`, before);
      }
      case "press": {
        await this.browser.ensureVisible(tab);
        const before = wc.getURL();
        await this.key(wc, request.key);
        return this.afterAction(wc, `Pressed ${request.key}.`, before);
      }
      case "back": {
        const before = wc.getURL();
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return this.afterAction(wc, "Went back.", before);
      }
      case "screenshot": {
        await this.browser.ensureVisible(tab);
        const { data } = (await cdp(wc, "Page.captureScreenshot", { format: "png" })) as { data: string };
        let image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
        if (image.isEmpty()) throw new Error("The page could not be captured.");
        const size = image.getSize();
        const fit = screenshotSize(size.width, size.height, SCREENSHOT_LONG_EDGE);
        if (fit) image = image.resize(fit);
        return { ...this.where(wc), image: image.toJPEG(75).toString("base64") };
      }
      case "evaluate": {
        const value: unknown = await wc.executeJavaScript(request.expression, true);
        const text = value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return { ...this.where(wc), text: clip(text ?? String(value)) };
      }
      case "console": {
        const entries = tab.console.slice(-100);
        if (request.clear) tab.console.length = 0;
        const text = entries.length
          ? entries.map((entry) => `[${entry.level}] ${entry.message}${entry.source ? `  (${entry.source})` : ""}`).join("\n")
          : "No console messages.";
        return { ...this.where(wc), text: clip(text) };
      }
      case "state":
        return this.where(wc);
      case "viewport": {
        await this.browser.ensureVisible(tab);
        const set = request.reset ? undefined : request.set;
        if (!request.reset && !set) return { ...this.where(wc), viewport: tab.viewport };
        const viewport = await this.browser.setViewport(tab.id, set && resolveViewport({ ...set, source: "agent" }));
        return { ...this.where(wc), viewport };
      }
    }
  }

  private async open(handle: string, input: string, newTab: boolean): Promise<AgentResult> {
    const url = normalizeAddress(input);
    if (!/^(https?|file):/i.test(url)) throw new Error(`Only http(s) and file URLs can be opened, got ${url}`);
    const existing = newTab ? undefined : this.agentTab(handle);
    const tab = existing ?? this.browser.createTab(undefined, handle);
    tab.agent = handle;
    log.info("browser", `${handle.slice(0, 4)} open ${url}`);
    await this.browser.ensureVisible(tab);
    await this.browser.load(tab, url);
    return this.snapshot(tab.view.webContents);
  }

  /** The session's own tab, else adopt the tab the user is looking at. */
  private tabFor(handle: string): Tab {
    const own = this.agentTab(handle);
    if (own) return own;
    const active = this.browser.active();
    if (!active) throw new Error("No browser tab is open. Use browser_open first.");
    active.agent = handle;
    return active;
  }

  private agentTab(handle: string): Tab | undefined {
    const active = this.browser.active();
    if (active?.agent === handle) return active;
    return [...this.browser.tabs.values()].reverse().find((tab) => tab.agent === handle);
  }

  private where(wc: WebContents): AgentResult {
    return { url: wc.getURL(), title: wc.getTitle() };
  }

  private exec<T>(wc: WebContents, code: string): Promise<T> {
    return wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]) as Promise<T>;
  }

  private async snapshot(wc: WebContents): Promise<AgentResult> {
    const result = await this.exec<{ url: string; title: string; text: string; refs: number }>(wc, SNAPSHOT);
    return { url: result.url, title: result.title, text: result.text || "(empty page)" };
  }

  /** Wait for a navigation the action may have caused, then report where we are. */
  private async afterAction(wc: WebContents, note: string, before: string): Promise<AgentResult> {
    let navigating = false;
    const onStart = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) navigating = true;
    };
    wc.on("did-start-navigation", onStart);
    await delay(300);
    wc.off("did-start-navigation", onStart);
    if (navigating || wc.isLoading()) await waitForStop(wc, 15_000);
    if (wc.getURL() !== before) {
      const snap = await this.snapshot(wc).catch(() => this.where(wc));
      return { ...snap, text: `${note} Navigated to ${wc.getURL()}.\n\n${snap.text ?? ""}` };
    }
    return { ...this.where(wc), text: `${note} Use browser_snapshot to see the updated page.` };
  }

  private async key(wc: WebContents, spec: string): Promise<void> {
    const parts = spec.split("+").map((part) => part.trim()).filter(Boolean);
    const def = keyDef(parts.pop() ?? "");
    const modifiers = parts.reduce((bits, part) => bits | (MODIFIER_BITS[part.toLowerCase()] ?? 0), 0);
    // Text only without command modifiers, so Meta+A is a shortcut rather than typing "a".
    const text = modifiers & ~8 ? undefined : def.text;
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
    await cdp(wc, "Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
    await cdp(wc, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }
}

function waitForStop(wc: WebContents, timeoutMs: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wc.off("did-stop-loading", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    wc.on("did-stop-loading", done);
  });
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… (${text.length - TEXT_LIMIT} more characters)` : text;
}
