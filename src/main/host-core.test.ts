import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", getPath: () => "/tmp" }, shell: {}, dialog: {} }));

import { DESKTOP_ONLY_METHODS, HOST_ERROR_STATUS, methodScope, type HostMethod } from "../shared/host-api";
import { IPC } from "../shared/ipc";
import { createHostCore, dispatch, type HostContext, type HostDeps, IPC_ROUTES } from "./host-core";

const calls: unknown[][] = [];
const record = (name: string) => (...args: unknown[]) => (calls.push([name, ...args]), Promise.resolve({ name }));
const deps = {
  shellEnv: Promise.resolve(),
  host: { respondDialog: (...args: unknown[]) => calls.push(["respondDialog", ...args]) },
  tasks: { start: record("tasks.start"), addCard: record("tasks.addCard"), send: record("tasks.send") },
  board: {},
  cardImages: {},
  settings: { get: record("settings.get") },
  uiState: {},
  computerPolicy: {},
  computerHelper: {},
  computerAgent: { preview: async (handle: string) => (handle === "held" ? { mimeType: "image/jpeg", data: "AAAA", app: "Calc" } : null) },
  laments: {},
  github: { project: record("github.project"), list: record("github.list") },
  atp: { watch: record("atp.watch") },
  auth: {
    signIn: async (_provider: string, _method: string, onUpdate: (update: unknown) => void) => {
      onUpdate({ kind: "event", event: { type: "auth_url", url: "https://login.example/x", opened: false } });
      return { ok: true };
    },
  },
  browser: () => undefined,
  updater: () => undefined,
  native: { pickFolder: record("pickFolder") },
} as unknown as HostDeps;
const core = createHostCore(deps);

const desktop = (extra: Partial<HostContext> = {}): HostContext => ({ client: "desktop", clientId: "desktop", openExternal: () => undefined, authUpdate: () => undefined, ...extra });
const phone = (extra: Partial<HostContext> = {}): HostContext => ({ ...desktop(), client: { device: "d1" }, clientId: "c1", ...extra });

describe("host methods table", () => {
  it("has a method for every IPC channel and no channel is routed twice", () => {
    const channels = Object.values(IPC).filter((channel) => typeof channel === "string");
    const routed = IPC_ROUTES.map((route) => route.channel);
    expect(new Set(routed).size).toBe(routed.length);
    for (const route of IPC_ROUTES) expect(core[route.method], route.method).toBeDefined();
    // Channels the main process pushes to the window have no route; every invoke/send channel does.
    const pushes = new Set<string>([IPC.events, IPC.attention, IPC.settingsChanged, IPC.uiChanged, IPC.boardChanged, IPC.lamentsChanged, IPC.themesChanged, IPC.computerChanged, IPC.atpPlans, IPC.atpHeld, IPC.atpRunners, IPC.atpThreadsChanged, IPC.browserState, IPC.browserReveal, IPC.browserAnnotation, IPC.updateState, IPC.updateReveal, IPC.authUpdate, IPC.pluginsLoginUpdate, IPC.setupLine, IPC.remoteChanged, IPC.devicesChanged, IPC.pairingChanged, IPC.pageToggle, IPC.sidebarToggle, IPC.browserToggle, IPC.windowFocus, IPC.openProject]);
    expect(channels.filter((channel) => !pushes.has(channel) && !routed.includes(channel))).toEqual([]);
  });

  it("agrees with the shared scope list", () => {
    for (const name of DESKTOP_ONLY_METHODS) if (core[name]) expect(core[name].scope, name).toBe("desktop");
    // Desktop-scoped here but not in the shared list: renderer-side orchestration that moves to main in later nodes.
    const extra = Object.keys(core).filter((name) => core[name]?.scope === "desktop" && methodScope(name as HostMethod) !== "desktop");
    expect(extra.sort()).toEqual(["atp.watch"]);
  });

  it("refuses desktop-only methods from a remote client, before validating or running", async () => {
    calls.length = 0;
    expect(() => dispatch(core, phone(), "fs.pickFolder", {})).toThrow(expect.objectContaining({ code: "scope_denied" }));
    expect(() => dispatch(core, phone(), "atp.importThreads", { threads: {} })).toThrow(expect.objectContaining({ code: "scope_denied" }));
    expect(calls).toEqual([]);
    await dispatch(core, desktop(), "fs.pickFolder", {});
    expect(calls).toEqual([["pickFolder"]]);
  });

  it("refuses unknown names, including inherited ones", () => {
    expect(() => dispatch(core, desktop(), "nope", {})).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => dispatch(core, desktop(), "constructor", {})).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(HOST_ERROR_STATUS.not_found).toBe(404);
  });

  it("keeps the project() absolute-path check", () => {
    expect(() => dispatch(core, desktop(), "github.project", { cwd: "repo" })).toThrow("a project is an absolute path");
    expect(() => dispatch(core, desktop(), "atp.start", { plan: "/p.atp.json", cwd: "repo" })).toThrow("a project is an absolute path");
    expect(() => dispatch(core, desktop(), "atp.stop", { plan: "relative.atp.json" })).toThrow("not an ATP plan path");
    // A phone could otherwise point atp.read at any readable JSON file.
    expect(() => dispatch(core, desktop(), "atp.read", { plan: "/etc/passwd" })).toThrow("not an ATP plan path");
    expect(() => dispatch(core, desktop(), "github.list", { cwd: "/r", kind: "issue", filter: "merged" })).toThrow("cannot list merged issues");
    expect(() => dispatch(core, desktop(), "providers.login", { provider: "x", method: "magic" })).toThrow("Unknown login");
    expect(() => dispatch(core, desktop(), "browser.viewport", { id: 3 })).toThrow("Invalid browser tab");
    expect(() => dispatch(core, desktop(), "browser.viewport", { id: "t", request: [] })).toThrow("Invalid viewport request");
    expect(() => dispatch(core, desktop(), "computer.openSettings", { pane: "x" })).toThrow("Unknown settings pane");
  });

  it("limits computer.preview to one per second per client and passes the handle through", async () => {
    vi.useFakeTimers();
    try {
      await expect(dispatch(core, phone({ clientId: "p1" }), "computer.preview", { handle: "held" })).resolves.toMatchObject({ app: "Calc" });
      expect(() => dispatch(core, phone({ clientId: "p1" }), "computer.preview", { handle: "held" })).toThrow(expect.objectContaining({ code: "rate_limited" }));
      await expect(dispatch(core, phone({ clientId: "p2" }), "computer.preview", { handle: "other" })).resolves.toBeNull();
      vi.advanceTimersByTime(1000);
      await expect(dispatch(core, phone({ clientId: "p1" }), "computer.preview", { handle: "held" })).resolves.toMatchObject({ app: "Calc" });
      expect(() => dispatch(core, phone(), "computer.preview", {})).toThrow(expect.objectContaining({ code: "bad_request" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a valid call", async () => {
    calls.length = 0;
    await expect(dispatch(core, desktop(), "github.project", { cwd: "/r", refresh: true })).resolves.toEqual({ name: "github.project" });
    expect(calls).toEqual([["github.project", "/r", true]]);
  });

  it("sends login side effects to the calling client only", async () => {
    const mine = { opened: [] as string[], updates: [] as unknown[] };
    const theirs = { opened: [] as string[], updates: [] as unknown[] };
    const ctx = (side: typeof mine, extra: Partial<HostContext> = {}) => ({ openExternal: (url: string) => side.opened.push(url), authUpdate: (update: unknown) => side.updates.push(update), ...extra });
    await dispatch(core, desktop(ctx(mine)), "providers.login", { provider: "anthropic", method: "oauth" });
    expect(mine.opened).toEqual(["https://login.example/x"]);
    expect(mine.updates).toHaveLength(1);
    expect(theirs.updates).toEqual([]);
    // A remote client opens the link itself: its openExternal is a no-op and the update carries the url.
    await dispatch(core, phone(ctx(theirs, { openExternal: () => undefined })), "providers.login", { provider: "anthropic", method: "oauth" });
    expect(theirs.opened).toEqual([]);
    expect(theirs.updates).toHaveLength(1);
    expect(mine.updates).toHaveLength(1);
  });

  it("maps positional IPC arguments onto the argument object", () => {
    const route = IPC_ROUTES.find((r) => r.channel === IPC.boardApply);
    expect(route?.args({ type: "remove", id: "a" }, 4)).toEqual({ op: { type: "remove", id: "a" }, baseRev: 4 });
  });
});

describe("starting a chat for a task", () => {
  it("lets a phone start a task, leasing the chat to that phone", async () => {
    calls.length = 0;
    await dispatch(core, phone(), "chat.startTask", { target: { kind: "investigate", card: "aaaaaa" } });
    expect(calls).toEqual([["tasks.start", { clientId: "c1", actor: "d1" }, { kind: "investigate", card: "aaaaaa" }]]);
  });

  it("adds a card from the desktop's channel, in a project", async () => {
    calls.length = 0;
    const route = IPC_ROUTES.find((r) => r.channel === IPC.addCard);
    await dispatch(core, desktop(), "board.addCard", route?.args("/repo", "todo", "fix it", undefined));
    expect(calls).toEqual([["tasks.addCard", "/repo", "todo", "fix it", []]]);
    expect(() => dispatch(core, desktop(), "board.addCard", { cwd: "repo", column: "todo", description: "x" })).toThrow("absolute path");
  });

  it("refuses malformed annotations on chat.send, and a host path that does not exist", async () => {
    await expect(dispatch(core, phone(), "chat.send", { handle: "h", text: "hi", annotations: ["x"] })).rejects.toThrow("invalid annotation");
    await expect(dispatch(core, phone(), "chat.send", { handle: "h", text: "hi", attachments: [{ path: "/no/such/file" }] })).rejects.toThrow("no such file");
  });
});

describe("chat reads for a phone", () => {
  const snapshots: unknown[][] = [];
  const host = {
    open: async () => ({ handle: "h1", reused: false, entries: [{ id: "e1" }] }),
    snapshot: (handle: string, page: unknown) => (snapshots.push([handle, page]), handle === "gone" ? undefined : { seq: 7, state: { handle }, turns: { total: 90, from: 50 } }),
    attentionAll: () => [],
  };
  const chats = createHostCore({ ...deps, host, app: { homeDir: "/Users/me", launchCwd: "/p", version: "1.0.0", buildId: "b" } } as unknown as HostDeps);

  it("sends the session's entries to the window only; a phone reads the snapshot", async () => {
    const request = { cwd: "/p", sessionPath: "/s.jsonl" };
    expect(await dispatch(chats, desktop(), "chat.open", { request })).toMatchObject({ entries: [{ id: "e1" }] });
    expect(await dispatch(chats, phone(), "chat.open", { request })).toEqual({ handle: "h1", reused: false, entries: [] });
  });

  it("pages snapshots by turn cursor and nests the seq beside the value", async () => {
    snapshots.length = 0;
    expect(await dispatch(chats, phone(), "chat.snapshot", { handle: "h1", before: 50 })).toEqual({ seq: 7, value: { state: { handle: "h1" }, turns: { total: 90, from: 50 } } });
    expect(snapshots).toEqual([["h1", { turns: 40, beforeTurn: 50 }]]);
    expect(() => dispatch(chats, phone(), "chat.snapshot", { handle: "gone" })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => dispatch(chats, phone(), "chat.snapshot", { handle: "h1", before: -1 })).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => dispatch(chats, phone(), "chat.snapshot", { before: 1 })).toThrow(expect.objectContaining({ code: "bad_request" }));
  });

  it("tells a phone the home folder", () => {
    expect(dispatch(chats, phone(), "app.info", {})).toMatchObject({ homeDir: "/Users/me" });
  });

  it("passes the caller to a dialog answer, so dialog_resolved names the device that answered", () => {
    calls.length = 0;
    const response = { type: "extension_ui_response", id: "d1", confirmed: true };
    dispatch(core, phone(), "chat.respondDialog", { handle: "abc123", response });
    dispatch(core, desktop(), "chat.respondDialog", { handle: "abc123", response });
    expect(calls.map((c) => (c[3] as { caller: unknown }).caller)).toEqual([{ device: "d1" }, "desktop"]);
  });
});
