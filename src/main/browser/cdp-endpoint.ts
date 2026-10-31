// A browser-level CDP endpoint over a chat's pane tabs, for CDP clients the agent runs itself (browser-use:
// `BU_CDP_WS=$PIGNA_CDP`). The client sees a browser whose pages are the chat's own web tabs; Target.* is answered
// here from the BrowserManager, and each attached session is relayed to its tab's webContents.debugger, the one
// session pi-gna's own browser tools use too (cdp.ts). The app window and other chats' tabs are never targets,
// which is why this is not Electron's --remote-debugging-port.
import { randomBytes } from "node:crypto";
import type { WebContents } from "electron";
import type { SocketRoute } from "../bridge";
import { log } from "../log";
import type { WebSocketConnection } from "../websocket";
import type { BrowserManager, Tab } from "./manager";

/** What the endpoint uses of BrowserManager. */
export type TabHost = Pick<BrowserManager, "tabs" | "createTab" | "closeTab" | "activate" | "ensureVisible" | "hold" | "release" | "markAgent">;

interface Command {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// Chrome's own codes and texts: browser-use matches "Session with given id not found" to recover a stale session.
const notFound = (method: string) => new CdpError(-32601, `'${method}' wasn't found`);
const noSession = () => new CdpError(-32001, "Session with given id not found.");
const noTarget = () => new CdpError(-32602, "No target with given id found");

/** URLs a client may open a tab on, as browser_open allows (plus the blank page clients start from). */
const OPENABLE = /^(https?|file):|^about:blank$/i;
/**
 * Never relayed on a page session. Target and Browser would reach past the tab (other targets, the app window). The
 * tab's one screencast is shared with the phone viewers and recordings (remote-view.ts), so a client starting or
 * stopping it would break those, and its frames would flood every client.
 */
const BLOCKED = /^(Target|Browser)\.|^Page\.(startScreencast|stopScreencast|screencastFrameAck)$/;
const DROPPED_EVENTS = new Set(["Page.screencastFrame", "Page.screencastVisibilityChanged"]);
/** The tab's "agent is using this" mark is refreshed at most this often. */
const MARK_MS = 1000;

/** The WebSocket route: one CDP connection per socket, acting for the token's chat. */
export function cdpRoute(host: () => TabHost | undefined): SocketRoute {
  return (handle, socket) => {
    const tabs = host();
    if (!tabs) return socket.close(1013, "the browser is not ready");
    new CdpConnection(tabs, handle, socket);
  };
}

interface Attached {
  tab: Tab;
  wc: WebContents;
}

export class CdpConnection {
  /** Our session ids, each on one tab. */
  private readonly sessions = new Map<string, Attached>();
  /** Per attached tab: the debugger and webContents listeners, removed when its last session goes. */
  private readonly watched = new Map<Tab, () => void>();
  private readonly marked = new Map<Tab, number>();
  private closed = false;

  constructor(
    private readonly host: TabHost,
    private readonly handle: () => string | undefined,
    private readonly socket: WebSocketConnection,
  ) {
    socket.onMessage((text) => void this.receive(text));
    socket.onClose(() => this.end());
  }

  private send(message: unknown): void {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }

  private async receive(text: string): Promise<void> {
    let command: Command;
    try {
      command = JSON.parse(text) as Command;
    } catch {
      return this.socket.close(1007, "not JSON");
    }
    if (typeof command?.id !== "number" || typeof command.method !== "string") return this.socket.close(1007, "not a CDP command");
    const sessionId = typeof command.sessionId === "string" ? command.sessionId : undefined;
    try {
      const owner = this.handle();
      if (!owner) return this.socket.close(1008, "session ended");
      const result = sessionId ? await this.relay(sessionId, command) : await this.browser(owner, command);
      this.send({ id: command.id, ...(sessionId ? { sessionId } : {}), result });
    } catch (error) {
      const { code, message } = error instanceof CdpError ? error : { code: -32000, message: (error as Error).message };
      this.send({ id: command.id, ...(sessionId ? { sessionId } : {}), error: { code, message } });
    }
  }

  /** A command on a tab's session: sent to the tab's debugger as is. */
  private async relay(sessionId: string, command: Command): Promise<unknown> {
    const attached = this.sessions.get(sessionId);
    if (!attached || attached.wc.isDestroyed()) throw noSession();
    if (BLOCKED.test(command.method)) throw notFound(command.method);
    this.mark(attached.tab);
    if (!attached.wc.debugger.isAttached()) attached.wc.debugger.attach("1.3");
    return attached.wc.debugger.sendCommand(command.method, command.params ?? {});
  }

  /** A browser-level command: the Target domain over the chat's tabs. */
  private async browser(owner: string, { method, params = {} }: Command): Promise<unknown> {
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: `Chrome/${process.versions.chrome}`,
          revision: "",
          userAgent: `pi-gna Electron/${process.versions.electron}`,
          jsVersion: process.versions.v8,
        };
      case "Target.getTargets":
        return { targetInfos: this.own(owner).map((tab) => this.info(tab)) };
      case "Target.getTargetInfo": {
        if (params.targetId === undefined) return { targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
        return { targetInfo: this.info(this.target(owner, params.targetId)) };
      }
      case "Target.createTarget": {
        const url = typeof params.url === "string" && params.url ? params.url : "about:blank";
        if (!OPENABLE.test(url)) throw new CdpError(-32000, `Only http(s), file and about:blank URLs can be opened, got ${url}`);
        const tab = this.host.createTab(url, owner);
        log.info("browser", `${owner.slice(0, 4)} cdp opened tab ${tab.id}`);
        await this.host.ensureVisible(tab);
        return { targetId: tab.id };
      }
      case "Target.closeTarget": {
        const tab = this.target(owner, params.targetId);
        this.host.closeTab(tab.id);
        return { success: true };
      }
      case "Target.activateTarget": {
        const tab = this.target(owner, params.targetId);
        this.host.activate(tab.id);
        await this.host.ensureVisible(tab);
        return {};
      }
      case "Target.attachToTarget": {
        const tab = this.target(owner, params.targetId);
        if (params.flatten !== true) throw new CdpError(-32000, "Only flatten mode is supported");
        const sessionId = randomBytes(16).toString("hex").toUpperCase();
        this.attach(sessionId, tab);
        this.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: this.info(tab), waitingForDebugger: false } });
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : [...this.sessions].find(([, attached]) => attached.tab.id === params.targetId)?.[0];
        if (!sessionId || !this.sessions.has(sessionId)) throw noSession();
        this.detach(sessionId);
        return {};
      }
      default:
        throw notFound(method);
    }
  }

  /** The chat's web tabs: file previews and cards are drawn by pi-gna, not pages a client could drive. */
  private own(owner: string): Tab[] {
    return [...this.host.tabs.values()].filter((tab) => tab.agent === owner && !tab.preview && !tab.card && !tab.view.webContents.isDestroyed());
  }

  private target(owner: string, targetId: unknown): Tab {
    const tab = typeof targetId === "string" ? this.host.tabs.get(targetId) : undefined;
    if (!tab || !this.own(owner).includes(tab)) throw noTarget();
    return tab;
  }

  private info(tab: Tab) {
    const wc = tab.view.webContents;
    const attached = [...this.sessions.values()].some((session) => session.tab === tab);
    return { targetId: tab.id, type: "page", title: wc.getTitle(), url: wc.getURL(), attached, canAccessOpener: false, browserContextId: "pigna" };
  }

  private mark(tab: Tab): void {
    const now = Date.now();
    if (now - (this.marked.get(tab) ?? 0) < MARK_MS) return;
    this.marked.set(tab, now);
    this.host.markAgent(tab);
  }

  private attach(sessionId: string, tab: Tab): void {
    const wc = tab.view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    this.sessions.set(sessionId, { tab, wc });
    if (this.watched.has(tab)) return;
    // A tab of a chat that is not on screen is in no window and stops rendering; holding it keeps it drawn, as for
    // browser_* actions and phone viewers.
    this.host.hold(tab.id);
    const onMessage = (_event: unknown, method: string, params: unknown, childSession?: string) => {
      // Events of the page itself; child sessions (iframes) are pi-gna's own, never attached through here.
      if (childSession || DROPPED_EVENTS.has(method)) return;
      for (const [id, session] of this.sessions) if (session.tab === tab) this.send({ method, params, sessionId: id });
    };
    // The user can cancel debugging from the DevTools banner, and a closed tab ends its sessions.
    const onGone = () => {
      for (const [id, session] of [...this.sessions]) if (session.tab === tab) this.detach(id);
    };
    wc.debugger.on("message", onMessage);
    wc.debugger.on("detach", onGone);
    wc.on("destroyed", onGone);
    this.watched.set(tab, () => {
      wc.debugger.off("message", onMessage);
      wc.debugger.off("detach", onGone);
      wc.off("destroyed", onGone);
      // A closed tab is gone from the manager already, and release ignores it.
      this.host.release(tab.id);
    });
  }

  private detach(sessionId: string): void {
    const attached = this.sessions.get(sessionId);
    if (!attached) return;
    this.sessions.delete(sessionId);
    this.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: attached.tab.id } });
    if ([...this.sessions.values()].some((session) => session.tab === attached.tab)) return;
    this.watched.get(attached.tab)?.();
    this.watched.delete(attached.tab);
    this.marked.delete(attached.tab);
  }

  private end(): void {
    this.closed = true;
    for (const id of [...this.sessions.keys()]) this.detach(id);
  }
}
