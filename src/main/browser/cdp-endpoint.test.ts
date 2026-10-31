import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocketConnection } from "../websocket";
import { CdpConnection, type TabHost } from "./cdp-endpoint";
import type { Tab } from "./manager";

/** A webContents whose debugger answers every command with its method and params. */
function fakeContents(url: string) {
  const debuggerEmitter = Object.assign(new EventEmitter(), {
    attached: false,
    sent: [] as string[],
    isAttached() {
      return this.attached;
    },
    attach() {
      this.attached = true;
    },
    async sendCommand(method: string, params: unknown) {
      this.sent.push(method);
      return { method, params };
    },
  });
  return Object.assign(new EventEmitter(), {
    debugger: debuggerEmitter,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getURL: () => url,
    getTitle: () => `title of ${url}`,
  });
}

type Contents = ReturnType<typeof fakeContents>;

function fakeHost() {
  const tabs = new Map<string, Tab>();
  const holds = new Map<string, number>();
  const add = (id: string, agent: string, extra: Partial<Tab> = {}) => {
    const tab = { id, agent, console: [], surface: "pane", holds: 0, view: { webContents: fakeContents(`https://${id}.example/`) }, ...extra } as unknown as Tab;
    tabs.set(id, tab);
    return tab;
  };
  const host: TabHost & { holds: Map<string, number>; add: typeof add } = {
    tabs,
    holds,
    add,
    createTab: (url?: string, agent?: string) => add(`new${tabs.size}`, agent ?? "", { view: { webContents: fakeContents(url ?? "") } } as unknown as Partial<Tab>),
    closeTab(id: string) {
      const tab = tabs.get(id);
      tabs.delete(id);
      const wc = tab?.view.webContents as unknown as Contents | undefined;
      if (wc) {
        wc.destroyed = true;
        wc.emit("destroyed");
      }
    },
    activate: () => undefined,
    ensureVisible: async () => undefined,
    hold: (id: string) => void holds.set(id, (holds.get(id) ?? 0) + 1),
    release: (id: string) => void holds.set(id, (holds.get(id) ?? 0) - 1),
    markAgent: () => undefined,
  } as unknown as TabHost & { holds: Map<string, number>; add: typeof add };
  return host;
}

/** A connection driven like a CDP client: `call` resolves with the reply to one command, `events` collects the rest. */
function client(host: TabHost, handle: () => string | undefined = () => "chat1") {
  let onMessage: (text: string) => void = () => undefined;
  let onClose: () => void = () => undefined;
  const replies = new Map<number, (reply: Record<string, unknown>) => void>();
  const events: Record<string, unknown>[] = [];
  const closes: number[] = [];
  const socket: WebSocketConnection = {
    send: (text) => {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (typeof message.id === "number") replies.get(message.id)?.(message);
      else events.push(message);
    },
    close: (code = 1000) => void closes.push(code),
    onMessage: (listener) => void (onMessage = listener),
    onClose: (listener) => void (onClose = listener),
  };
  new CdpConnection(host, handle, socket);
  let next = 1;
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      replies.set(id, resolve);
      onMessage(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { call, events, closes, end: () => onClose() };
}

const result = <T>(reply: Record<string, unknown>) => reply.result as T;

describe("CdpConnection", () => {
  it("lists only the chat's own web tabs as page targets", async () => {
    const host = fakeHost();
    host.add("a", "chat1");
    host.add("b", "chat2");
    host.add("p", "chat1", { preview: {} } as Partial<Tab>);
    host.add("c", "chat1", { card: "k1" });
    const { call } = client(host);
    const targets = result<{ targetInfos: { targetId: string; type: string; url: string }[] }>(await call("Target.getTargets")).targetInfos;
    expect(targets).toEqual([expect.objectContaining({ targetId: "a", type: "page", url: "https://a.example/" })]);
    expect((await call("Target.attachToTarget", { targetId: "b", flatten: true })).error).toMatchObject({ code: -32602 });
  });

  it("relays a session's commands to its tab's debugger and its events back with the session id", async () => {
    const host = fakeHost();
    const tab = host.add("a", "chat1");
    const wc = tab.view.webContents as unknown as Contents;
    const { call, events } = client(host);
    const { sessionId } = result<{ sessionId: string }>(await call("Target.attachToTarget", { targetId: "a", flatten: true }));
    expect(host.holds.get("a")).toBe(1);
    const reply = await call("Runtime.evaluate", { expression: "1+1" }, sessionId);
    expect(reply).toMatchObject({ sessionId, result: { method: "Runtime.evaluate", params: { expression: "1+1" } } });
    expect(wc.debugger.attached).toBe(true);

    wc.debugger.emit("message", {}, "Page.loadEventFired", { timestamp: 1 }, "");
    wc.debugger.emit("message", {}, "Page.screencastFrame", { data: "x" }, "");
    wc.debugger.emit("message", {}, "Runtime.consoleAPICalled", {}, "CHILD");
    expect(events.filter((event) => event.method !== "Target.attachedToTarget")).toEqual([{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId }]);
  });

  it("refuses Target, Browser and screencast commands on a page session", async () => {
    const host = fakeHost();
    const wc = host.add("a", "chat1").view.webContents as unknown as Contents;
    const { call } = client(host);
    const { sessionId } = result<{ sessionId: string }>(await call("Target.attachToTarget", { targetId: "a", flatten: true }));
    for (const method of ["Target.getTargets", "Target.attachToBrowserTarget", "Browser.close", "Page.startScreencast"])
      expect((await call(method, {}, sessionId)).error).toMatchObject({ code: -32601 });
    expect(wc.debugger.sent).toEqual([]);
  });

  it("answers an unknown session the way Chrome does, so a client re-attaches", async () => {
    const { call } = client(fakeHost());
    expect((await call("Runtime.evaluate", {}, "NOPE")).error).toEqual({ code: -32001, message: "Session with given id not found." });
  });

  it("creates tabs for the chat and refuses other schemes", async () => {
    const host = fakeHost();
    const { call } = client(host);
    const { targetId } = result<{ targetId: string }>(await call("Target.createTarget", { url: "about:blank", background: true }));
    expect(host.tabs.get(targetId)?.agent).toBe("chat1");
    expect((await call("Target.createTarget", { url: "pigna-file://x/etc/passwd" })).error).toMatchObject({ code: -32000 });
  });

  it("ends a tab's sessions when it closes, and releases every hold when the client goes", async () => {
    const host = fakeHost();
    host.add("a", "chat1");
    host.add("b", "chat1");
    const { call, events, end } = client(host);
    const first = result<{ sessionId: string }>(await call("Target.attachToTarget", { targetId: "a", flatten: true })).sessionId;
    await call("Target.attachToTarget", { targetId: "a", flatten: true });
    await call("Target.attachToTarget", { targetId: "b", flatten: true });
    expect(host.holds.get("a")).toBe(1);
    expect(result(await call("Target.closeTarget", { targetId: "a" }))).toEqual({ success: true });
    expect(events.filter((event) => event.method === "Target.detachedFromTarget")).toHaveLength(2);
    expect((await call("Runtime.evaluate", {}, first)).error).toMatchObject({ code: -32001 });
    end();
    expect(host.holds.get("a")).toBe(0);
    expect(host.holds.get("b")).toBe(0);
  });

  it("closes the socket once the chat's token was unregistered", async () => {
    let handle: string | undefined = "chat1";
    const { call, closes } = client(fakeHost(), () => handle);
    expect(result(await call("Target.getTargets"))).toEqual({ targetInfos: [] });
    handle = undefined;
    void call("Target.getTargets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toEqual([1008]);
  });
});
