// Agent browser actions behind the browser_* tools. Each pi session drives its own tab. Input and
// screenshots go through CDP (webContents.debugger): OS-level input and capturePage need composited
// frames, which Chromium stops producing while the app window is hidden behind other windows.
import { homedir } from "node:os";
import { nativeImage, type WebContents } from "electron";
import { type AgentAction, type AgentResult, normalizeAddress, screenshotSize, viewportLine } from "../../shared/browser";
import { parseLocalTarget, previewLabel } from "../../shared/preview";
import { resolveViewport, toInputCoords, type ViewportSpec } from "../../shared/viewport";
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

/** CDP Runtime.evaluate reply (RemoteObject and ExceptionDetails, the fields used here). */
interface Evaluated {
  result: { type: string; value?: unknown; unserializableValue?: string; description?: string; objectId?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ACTIONS = new Set(["open", "snapshot", "click", "type", "press", "screenshot", "evaluate", "console", "back", "state", "viewport", "window"]);

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
    if (request.action === "open") return this.open(handle, request.url, request.newTab ?? false, request.tab, request.cwd);
    if (request.action === "window") return this.window(handle, request);
    const tab = this.tabFor(handle, request.tab);
    // A tab of a chat that is not on screen is in no window; holding it keeps the page rendering for the action.
    this.browser.hold(tab.id);
    try {
      return await this.act(handle, request, tab);
    } finally {
      this.browser.release(tab.id);
    }
  }

  private async act(handle: string, request: Exclude<AgentAction, { action: "open" | "window" }>, tab: Tab): Promise<AgentResult> {
    const wc = tab.view.webContents;
    this.browser.markAgent(tab);
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
        // Input takes view pixels; a fitted viewport is drawn scaled.
        const { x, y } = toInputCoords(point.x, point.y, tab.emulatedScale ?? 1);
        if (tab.viewport?.touch) {
          // Under touch emulation a CDP mouse press becomes a touch whose ack never comes, which would wedge this queue; tap instead.
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await cdp(wc, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
          }
        }
        return this.afterAction(wc, `Clicked [${request.ref}].`, before);
      }
      case "type": {
        await this.browser.ensureVisible(tab);
        const ok = await this.exec<boolean>(wc, focusForTyping(request.ref, request.clear ?? true));
        if (!ok) throw new Error(`No element [${request.ref}] on the page. Take a new browser_snapshot first.`);
        const before = wc.getURL();
        await cdp(wc, "Input.insertText", { text: request.text });
        if (request.submit) await pressKey(wc, "Enter");
        return this.afterAction(wc, `Typed into [${request.ref}]${request.submit ? " and pressed Enter" : ""}.`, before);
      }
      case "press": {
        await this.browser.ensureVisible(tab);
        const before = wc.getURL();
        await pressKey(wc, request.key);
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
        // REPL mode, like the DevTools console: top-level await works and statements return their last value.
        // (executeJavaScript runs a classic script, where await is a syntax error reported as "Script failed to execute".)
        // REPL mode only awaits its own wrapper, so an object result goes through callFunctionOn, which awaits a
        // returned promise and serializes the value.
        const group = "pigna-evaluate";
        let reply = (await cdp(wc, "Runtime.evaluate", { expression: request.expression, replMode: true, awaitPromise: true, userGesture: true, objectGroup: group })) as Evaluated;
        try {
          if (!reply.exceptionDetails && reply.result.objectId) {
            reply = (await cdp(wc, "Runtime.callFunctionOn", {
              objectId: reply.result.objectId,
              functionDeclaration: "function () { return this; }",
              awaitPromise: true,
              returnByValue: true,
              userGesture: true,
            })) as Evaluated;
          }
        } finally {
          await cdp(wc, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
        }
        const { result, exceptionDetails } = reply;
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        const value = result.value;
        const text =
          result.unserializableValue ?? (result.type === "undefined" ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
        return { ...this.where(wc), text: clip(text ?? result.description ?? String(value)) };
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
        const viewport = await this.browser.setViewport(tab.id, set && { ...set, source: "agent" });
        return { ...this.where(wc), viewport };
      }
    }
  }

  private async window(handle: string, request: Extract<AgentAction, { action: "window" }>): Promise<AgentResult> {
    log.info("browser", `${handle.slice(0, 4)} window ${request.op}`);
    if (request.op === "list") {
      const windows = [...this.browser.tabs.values()].filter((tab) => tab.win);
      const text = windows.length
        ? windows.map((tab) => `[${tab.id}] ${tab.viewport ? viewportLine(tab.viewport) : "no viewport"} ${tab.view.webContents.getURL()}${tab.agent === handle ? "" : " (not yours)"}`).join("\n")
        : "No browser windows are open.";
      return { url: "", title: "", text };
    }
    if (request.op === "close") {
      const tab = request.tab ? this.tabFor(handle, request.tab) : this.agentTab(handle);
      if (!tab?.win) throw new Error("Give the tab id of a window to close (see op: list).");
      const result = this.where(tab.view.webContents);
      this.browser.closeTab(tab.id);
      return { ...result, text: `Closed window [${tab.id}].` };
    }
    let spec: ViewportSpec;
    try {
      spec = resolveViewport({ ...request.set, source: "agent" });
    } catch (error) {
      throw new Error(`Invalid window size: ${error instanceof Error ? error.message : String(error)}`);
    }
    const url = request.url ? normalizeAddress(request.url) : undefined;
    if (url && !/^(https?|file|about):/i.test(url)) throw new Error(`Only http(s) and file URLs can be opened, got ${url}`);
    const tab = await this.browser.openWindow({ ...request.set, source: "agent" }, url, handle);
    this.browser.activate(tab.id);
    const wc = tab.view.webContents;
    const viewport = tab.viewport ?? spec;
    const [width = 0, height = 0] = tab.win?.getContentSize() ?? [];
    const clamped = width !== viewport.width || height !== viewport.height ? ` The screen limited the window to ${width}x${height}; the page still sees ${viewport.width}x${viewport.height}.` : "";
    const note = `Opened window [${tab.id}] at ${viewport.width}x${viewport.height} @${viewport.dpr}x. It is now your current tab; pass tab: "${tab.id}" to other browser tools to address it later.${clamped}`;
    const snap = url ? await this.snapshot(wc).catch(() => this.where(wc)) : this.where(wc);
    return { ...snap, tab: tab.id, viewport, text: `${note}${snap.text ? `\n\n${snap.text}` : ""}` };
  }

  /** A local file opens as a preview tab; the result names the file instead of the internal preview URL. */
  private async openFile(handle: string, target: { path: string; line?: number }, newTab: boolean, cwd?: string): Promise<AgentResult> {
    log.info("browser", `${handle.slice(0, 4)} preview ${target.path}`);
    const tab = await this.browser.openPreview(target.path, { newTab, agent: handle, line: target.line, root: cwd });
    tab.agent = handle;
    const wc = tab.view.webContents;
    await this.browser.ensureVisible(tab);
    await waitForStop(wc, 15_000);
    const info = tab.preview?.info;
    const snap = await this.snapshot(wc).catch(() => this.where(wc));
    const note = `Opened a preview of ${target.path}${info ? ` (${info.kind}, ${info.mode} view)` : ""}. Tab [${tab.id}] is your current tab.`;
    return { ...snap, url: target.path, title: previewLabel(target.path), tab: tab.id, text: `${note}\n\n${snap.text ?? ""}` };
  }

  private async open(handle: string, input: string, newTab: boolean, tabId?: string, cwd?: string): Promise<AgentResult> {
    const local = parseLocalTarget(input, cwd, homedir());
    if (local) return this.openFile(handle, local, newTab, cwd);
    const url = normalizeAddress(input);
    if (!/^(https?|file):/i.test(url)) throw new Error(`Only http(s) and file URLs can be opened, got ${url}`);
    const existing = tabId ? this.tabFor(handle, tabId) : newTab ? undefined : this.agentTab(handle);
    const tab = existing ?? this.browser.createTab(undefined, handle);
    tab.agent = handle;
    log.info("browser", `${handle.slice(0, 4)} open ${url}`);
    await this.browser.ensureVisible(tab);
    await this.browser.load(tab, url);
    return this.snapshot(tab.view.webContents);
  }

  /** The chat's own tab: the one it addressed last, else its newest. */
  private tabFor(handle: string, id?: string): Tab {
    if (id) {
      const named = this.browser.tabs.get(id);
      if (!named) throw new Error(`No browser tab ${id}. Use browser_window with op: list.`);
      if (named.agent && named.agent !== handle) throw new Error(`Browser tab ${id} belongs to another chat.`);
      named.agent = handle;
      return named;
    }
    const own = this.agentTab(handle);
    if (!own) throw new Error("No browser tab is open. Use browser_open first.");
    return own;
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
}

/** Press a key or chord ("Enter", "Meta+A") in a tab over CDP. */
export async function pressKey(wc: WebContents, spec: string): Promise<void> {
  const parts = spec.split("+").map((part) => part.trim()).filter(Boolean);
  const def = keyDef(parts.pop() ?? "");
  const modifiers = parts.reduce((bits, part) => bits | (MODIFIER_BITS[part.toLowerCase()] ?? 0), 0);
  // Text only without command modifiers, so Meta+A is a shortcut rather than typing "a".
  const text = modifiers & ~8 ? undefined : def.text;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
  await cdp(wc, "Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
  await cdp(wc, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
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
