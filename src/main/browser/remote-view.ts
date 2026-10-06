// The host side of the phone's browser: a screencast per watched tab, input over CDP, and comment-mode picks.
// Frames come from Page.startScreencast and input from the tab's shared debugger session, because the window may be
// hidden or the pane closed (docs/REMOTE_BROWSER_SPIKE.md): screenshots and OS input stop working then, these do not.
import { randomUUID } from "node:crypto";
import { nativeImage } from "electron";
import type { Annotation } from "../../shared/browser";
import { type FrameParams, frameParams, inputPoint, mergeFrameParams, sameFrameParams, type ViewerSpec } from "../../shared/browser-view";
import type { BrowserInput } from "../../shared/host-api";
import { log } from "../log";
import { pressKey } from "./agent";
import { cdp } from "./cdp";
import type { BrowserManager, Tab } from "./manager";
import { ISOLATED_WORLD, pickAt } from "./page-scripts";

/** One screencast frame for a viewer. `cssWidth` x `cssHeight` is the page viewport the frame shows, in input coordinates. */
export interface Frame {
  jpeg: Buffer;
  cssWidth: number;
  cssHeight: number;
}

export interface ViewHandle {
  close(): void;
}

const LONG_PRESS_MS = 650;
const DRAG_STEPS = 8;
const WHEEL_LIMIT = 5000;
const TEXT_LIMIT = 10_000;
const COMMENT_LIMIT = 4000;

interface Viewer {
  params: FrameParams;
  onFrame(frame: Frame): void;
}

interface Cast {
  tab: Tab;
  viewers: Set<Viewer>;
  params?: FrameParams;
  last?: Frame;
  onMessage(event: unknown, method: string, params: { data?: string; sessionId?: number }): void;
  onDetach(): void;
  restart?: ReturnType<typeof setTimeout>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteBrowser {
  private readonly casts = new Map<string, Cast>();
  /** Start/stop steps per tab run one after another, so a viewer leaving cannot stop the screencast a new one just started. */
  private readonly steps = new Map<string, Promise<void>>();

  constructor(private readonly browser: BrowserManager) {}

  /** Number of tabs being streamed. */
  get watching(): number {
    return this.casts.size;
  }

  /** Start sending frames of a tab to `onFrame`; the screencast runs only while someone watches. Throws on an unknown tab. */
  open(id: string, viewer: ViewerSpec, onFrame: (frame: Frame) => void): ViewHandle {
    let cast = this.casts.get(id);
    if (!cast) {
      const tab = this.browser.hold(id);
      cast = this.makeCast(tab);
      this.casts.set(id, cast);
    }
    const entry: Viewer = { params: frameParams(viewer), onFrame };
    cast.viewers.add(entry);
    // A viewer joining late gets the picture at once instead of waiting for the page to change.
    if (cast.last) onFrame(cast.last);
    void this.apply(id, cast);
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        const current = this.casts.get(id);
        if (!current) return;
        current.viewers.delete(entry);
        void this.apply(id, current);
      },
    };
  }

  /** Close every stream (remote access turned off, device revoked, quit). */
  closeAll(): void {
    for (const [id, cast] of [...this.casts]) {
      cast.viewers.clear();
      void this.apply(id, cast);
    }
  }

  private makeCast(tab: Tab): Cast {
    const cast: Cast = {
      tab,
      viewers: new Set(),
      onMessage: (_event, method, params) => {
        if (method !== "Page.screencastFrame" || typeof params.data !== "string") return;
        const wc = tab.view.webContents;
        // Ack at once, so Chromium keeps producing; delivery is throttled per viewer downstream.
        void cdp(wc, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
        deliver(cast, params.data);
      },
      // The user can cancel debugging from the DevTools banner, which ends the screencast with it.
      onDetach: () => {
        cast.params = undefined;
        if (!cast.viewers.size || cast.restart) return;
        cast.restart = setTimeout(() => {
          cast.restart = undefined;
          const id = [...this.casts].find(([, other]) => other === cast)?.[0];
          if (id) void this.apply(id, cast);
        }, 300);
      },
    };
    return cast;
  }

  /** Bring the tab's screencast in line with its viewers: start, restart on new settings, or stop and release the tab. */
  private apply(id: string, cast: Cast): Promise<void> {
    const next = (this.steps.get(id) ?? Promise.resolve()).then(() => this.applyNow(id, cast));
    this.steps.set(id, next);
    void next.finally(() => {
      if (this.steps.get(id) === next) this.steps.delete(id);
    });
    return next;
  }

  private async applyNow(id: string, cast: Cast): Promise<void> {
    const wc = cast.tab.view.webContents;
    const want = mergeFrameParams([...cast.viewers].map((viewer) => viewer.params));
    try {
      if (!want) {
        if (this.casts.get(id) === cast) this.casts.delete(id);
        clearTimeout(cast.restart);
        wc.debugger.off("message", cast.onMessage);
        wc.debugger.off("detach", cast.onDetach);
        if (cast.params && !wc.isDestroyed() && wc.debugger.isAttached()) await cdp(wc, "Page.stopScreencast").catch(() => undefined);
        this.browser.release(id);
        return;
      }
      if (sameFrameParams(cast.params, want)) return;
      if (!cast.params) {
        wc.debugger.on("message", cast.onMessage);
        wc.debugger.on("detach", cast.onDetach);
        await cdp(wc, "Page.enable");
      } else {
        await cdp(wc, "Page.stopScreencast");
      }
      cast.params = want;
      await cdp(wc, "Page.startScreencast", { format: "jpeg", quality: want.quality, maxWidth: want.maxWidth, maxHeight: want.maxHeight, everyNthFrame: want.everyNthFrame });
      // A screencast sends frames only as the page repaints, so a static page that painted before it started (a file
      // preview) would show nothing: its first picture is a screenshot, unless a screencast frame comes first.
      if (!cast.last) {
        const shot = (await cdp(wc, "Page.captureScreenshot", { format: "jpeg", quality: want.quality }).catch(() => undefined)) as { data: string } | undefined;
        if (shot && !cast.last && cast.params === want) deliver(cast, shot.data);
      }
    } catch (error) {
      cast.params = undefined;
      log.warn("browser", `remote screencast: ${(error as Error).message}`);
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Do one input on a tab; returns the annotation for a `pick`, null otherwise. */
  async input(id: string, input: BrowserInput): Promise<{ annotation?: Annotation } | null> {
    const watched = this.casts.get(id);
    const tab = watched?.tab ?? this.browser.hold(id);
    try {
      return await this.perform(tab, watched, input);
    } finally {
      if (!watched) this.browser.release(id);
    }
  }

  private async perform(tab: Tab, cast: Cast | undefined, input: BrowserInput): Promise<{ annotation?: Annotation } | null> {
    const wc = tab.view.webContents;
    const page = pageSize(tab);
    const at = (x: number, y: number) => inputPoint(x, y, page, tab.emulatedScale ?? 1);
    const touch = !!tab.viewport?.touch;
    switch (input.type) {
      case "tap": {
        const { x, y } = at(input.x, input.y);
        if (touch) {
          // Under touch emulation a CDP mouse press becomes a touch whose ack never comes; tap instead.
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp(wc, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        }
        return null;
      }
      case "longPress": {
        const { x, y } = at(input.x, input.y);
        if (touch) {
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await delay(LONG_PRESS_MS);
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          // Without touch, a long press is what a right click is: the page's context menu.
          await cdp(wc, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await cdp(wc, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
          await cdp(wc, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
        }
        return null;
      }
      case "scroll": {
        const { x, y } = at(input.x, input.y);
        const limit = (n: number) => Math.max(-WHEEL_LIMIT, Math.min(WHEEL_LIMIT, Number.isFinite(n) ? n : 0));
        await cdp(wc, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: limit(input.dx), deltaY: limit(input.dy) });
        return null;
      }
      case "drag": {
        const from = at(input.x, input.y);
        const to = at(input.toX, input.toY);
        const step = (n: number) => ({ x: from.x + ((to.x - from.x) * n) / DRAG_STEPS, y: from.y + ((to.y - from.y) * n) / DRAG_STEPS });
        if (touch) {
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
          for (let n = 1; n <= DRAG_STEPS; n++) await cdp(wc, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [step(n)] });
          await cdp(wc, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await cdp(wc, "Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
          await cdp(wc, "Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 });
          for (let n = 1; n <= DRAG_STEPS; n++) await cdp(wc, "Input.dispatchMouseEvent", { type: "mouseMoved", ...step(n), button: "left", buttons: 1 });
          await cdp(wc, "Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
        }
        return null;
      }
      case "text": {
        if (typeof input.text !== "string" || !input.text || input.text.length > TEXT_LIMIT) throw new Error("Invalid text");
        await cdp(wc, "Input.insertText", { text: input.text });
        return null;
      }
      case "key": {
        if (typeof input.key !== "string" || input.key.length > 40) throw new Error("Invalid key");
        await pressKey(wc, input.key);
        return null;
      }
      case "pick":
        return { annotation: await this.pick(tab, cast, input, page) };
      default:
        throw new Error("Unknown input");
    }
  }

  /** Comment mode: the element at the point, described like the desktop picker does, with a crop from the last frame. */
  private async pick(tab: Tab, cast: Cast | undefined, input: Extract<BrowserInput, { type: "pick" }>, page: { width: number; height: number }): Promise<Annotation> {
    const comment = typeof input.comment === "string" ? input.comment.trim() : "";
    if (!comment || comment.length > COMMENT_LIMIT) throw new Error("A comment is required");
    const point = { x: Math.max(0, Math.min(page.width - 1, Number(input.x) || 0)), y: Math.max(0, Math.min(page.height - 1, Number(input.y) || 0)) };
    const wc = tab.view.webContents;
    type Picked = Omit<Annotation, "id" | "image" | "comment"> & { rect: { x: number; y: number; width: number; height: number } };
    const picked = (await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: pickAt(point.x, point.y) }], true)) as Picked | null;
    if (!picked) throw new Error("No element at that point");
    const { rect, ...rest } = picked;
    return { ...rest, comment, id: randomUUID().slice(0, 8), image: cast?.last ? cropFrame(cast.last, rect) : undefined };
  }
}

/** The page viewport a tab shows, in CSS px: its emulated size, or the view's own size. */
/** A frame of the tab's page to every viewer, kept for viewers who join later. */
function deliver(cast: Cast, base64: string): void {
  const size = pageSize(cast.tab);
  const frame: Frame = { jpeg: Buffer.from(base64, "base64"), cssWidth: size.width, cssHeight: size.height };
  cast.last = frame;
  for (const viewer of cast.viewers) viewer.onFrame(frame);
}

function pageSize(tab: Tab): { width: number; height: number } {
  if (tab.viewport) return { width: tab.viewport.width, height: tab.viewport.height };
  const { width, height } = tab.view.getBounds();
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** JPEG of an element (CSS px rect) cut from a frame, 12 px padded and at most 800 px wide, like the desktop annotation crop. */
function cropFrame(frame: Frame, rect: { x: number; y: number; width: number; height: number }): string | undefined {
  const image = nativeImage.createFromBuffer(frame.jpeg);
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  const scale = size.width / frame.cssWidth;
  const pad = 12;
  const x = Math.max(0, Math.round((rect.x - pad) * scale));
  const y = Math.max(0, Math.round((rect.y - pad) * scale));
  const width = Math.min(size.width - x, Math.round((rect.width + pad * 2) * scale));
  const height = Math.min(size.height - y, Math.round((Math.min(rect.height, 600) + pad * 2) * scale));
  if (width < 1 || height < 1) return undefined;
  const crop = image.crop({ x, y, width, height });
  return (width > 800 ? crop.resize({ width: 800 }) : crop).toJPEG(80).toString("base64");
}
