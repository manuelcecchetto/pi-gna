import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app", getPath: () => "/tmp" }, shell: {}, dialog: {} }));

import { DESKTOP_ONLY_METHODS, HOST_ERROR_STATUS, methodScope, type HostMethod } from "../shared/host-api";
import { IPC } from "../shared/ipc";
import { createHostCore, dispatch, type HostContext, type HostDeps, IPC_ROUTES } from "./host-core";

const calls: unknown[][] = [];
const record = (name: string) => (...args: unknown[]) => (calls.push([name, ...args]), Promise.resolve({ name }));
const deps = {
  shellEnv: Promise.resolve(),
  piDirs: Promise.resolve(),
  host: { respondDialog: (...args: unknown[]) => calls.push(["respondDialog", ...args]) },
  tasks: { start: record("tasks.start"), addCard: record("tasks.addCard"), send: record("tasks.send") },
  board: {},
  cardImages: {},
  settings: { get: record("settings.get"), apply: record("settings.apply") },
  plugins: { state: record("plugins.state") },
  uiState: {},
  computerPolicy: {},
  computerHelper: { call: () => Promise.reject(new Error("Computer Use helper is missing from this build (/x.app)")) },
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
    const pushes = new Set<string>([IPC.events, IPC.attention, IPC.settingsChanged, IPC.uiChanged, IPC.boardChanged, IPC.lamentsChanged, IPC.themesChanged, IPC.computerChanged, IPC.atpPlans, IPC.atpHeld, IPC.atpRunners, IPC.atpThreadsChanged, IPC.browserState, IPC.browserReveal, IPC.browserAnnotation, IPC.updateState, IPC.updateReveal, IPC.authUpdate, IPC.pluginsLoginUpdate, IPC.setupLine, IPC.remoteChanged, IPC.devicesChanged, IPC.pairingChanged, IPC.pageToggle, IPC.sidebarToggle, IPC.paletteToggle, IPC.browserToggle, IPC.windowFocus, IPC.openProject]);
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

  it("lets only the desktop switch yolo", async () => {
    calls.length = 0;
    expect(() => dispatch(core, phone(), "settings.apply", { op: { type: "yolo", on: true } })).toThrow(expect.objectContaining({ code: "scope_denied" }));
    await dispatch(core, phone(), "settings.apply", { op: { type: "visuals", on: true } });
    await dispatch(core, desktop(), "settings.apply", { op: { type: "yolo", on: true } });
    expect(calls).toEqual([
      ["settings.apply", { type: "visuals", on: true }, undefined],
      ["settings.apply", { type: "yolo", on: true }, undefined],
    ]);
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

  it("tells a phone why the Computer Use helper cannot answer", async () => {
    await expect(dispatch(core, phone(), "computer.permissions", {})).rejects.toMatchObject({ code: "unavailable", message: "Computer Use helper is missing from this build (/x.app)" });
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

  it.skipIf(process.platform !== "win32")("accepts Windows drive and UNC projects in the plugins page", async () => {
    for (const cwd of ["C:\\Users\\dev\\my project", "C:/Users/dev/my project", "\\\\server\\share\\project"]) {
      calls.length = 0;
      await expect(dispatch(core, desktop(), "plugins.state", { cwd })).resolves.toEqual({ name: "plugins.state" });
      expect(calls).toEqual([["plugins.state", cwd]]);
    }
  });

  it("rejects relative and invalid plugin project paths but permits global settings", async () => {
    for (const cwd of ["repo", "C:repo", "", "/repo\0bad", 42]) {
      expect(() => dispatch(core, desktop(), "plugins.state", { cwd })).toThrow("a project is an absolute path");
    }
    calls.length = 0;
    await dispatch(core, desktop(), "plugins.state", {});
    expect(calls).toEqual([["plugins.state", undefined]]);
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

describe("before the login shell answers", () => {
  // A Finder launch: pi's folders came from the last launch, the rest of the environment takes 1–2 s more.
  const waiting = createHostCore({ ...deps, shellEnv: new Promise<void>(() => undefined) });
  const settled = (value: unknown) => Promise.race([Promise.resolve(value).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);

  it("lists the sessions and reads pi's settings, which only read pi's files", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const saved = { dir: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };
    process.env.PI_CODING_AGENT_DIR = await mkdtemp(`${tmpdir()}/pigna-agent-`);
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      // Each resolves although the shell never answers.
      expect(await dispatch(waiting, desktop(), "chat.list", {})).toEqual([]);
      await dispatch(waiting, desktop(), "chat.compactionSettings", {});
      await dispatch(waiting, desktop(), "settings.pi", {});
    } finally {
      if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved.dir;
      if (saved.sessions !== undefined) process.env.PI_CODING_AGENT_SESSION_DIR = saved.sessions;
    }
  });

  it("holds what spawns a process", async () => {
    calls.length = 0;
    expect(await settled(dispatch(waiting, desktop(), "plugins.state", {}))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("holds even the file reads until pi's folders are known", async () => {
    const first = createHostCore({ ...deps, shellEnv: new Promise<void>(() => undefined), piDirs: new Promise<void>(() => undefined) });
    expect(await settled(dispatch(first, desktop(), "chat.list", {}))).toBe(false);
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
  const opens: unknown[] = [];
  const host = {
    open: async (_request: unknown, _lease: unknown, page?: unknown) => (opens.push(page), { handle: "h1", reused: false, ...(page ? { snapshot: { seq: 7, state: { handle: "h1" }, turns: { total: 90, from: 50 } } } : {}) }),
    attach: () => undefined,
    snapshot: (handle: string, page: unknown) => (snapshots.push([handle, page]), handle === "gone" ? undefined : { seq: 7, state: { handle }, turns: { total: 90, from: 50 } }),
    attentionAll: () => [],
  };
  const chats = createHostCore({ ...deps, host, app: { homeDir: "/Users/me", launchCwd: "/p", version: "1.0.0", buildId: "b" } } as unknown as HostDeps);

  it("answers the window's open with its first page and the outline of earlier turns; a phone reads the snapshot", async () => {
    const request = { cwd: "/p", sessionPath: "/s.jsonl" };
    opens.length = 0;
    expect(await dispatch(chats, desktop(), "chat.open", { request })).toMatchObject({ handle: "h1", snapshot: { seq: 7 } });
    expect(await dispatch(chats, phone(), "chat.open", { request })).toEqual({ handle: "h1", reused: false });
    expect(opens).toEqual([{ turns: 40, bytes: 2_000_000, outline: true }, undefined]);
  });

  it("attaches the window with its first page, a phone with only the seq", () => {
    snapshots.length = 0;
    expect(dispatch(chats, desktop(), "chat.attach", { handle: "h1" })).toMatchObject({ seq: 7, state: { handle: "h1" } });
    expect(dispatch(chats, phone(), "chat.attach", { handle: "h1" })).toEqual({ seq: 7 });
    expect(snapshots).toEqual([["h1", { turns: 40, bytes: 2_000_000, outline: true }], ["h1", { turns: 1 }]]);
  });

  it("pages snapshots by turn cursor and nests the seq beside the value", async () => {
    snapshots.length = 0;
    expect(await dispatch(chats, phone(), "chat.snapshot", { handle: "h1", before: 50 })).toEqual({ seq: 7, value: { state: { handle: "h1" }, turns: { total: 90, from: 50 } } });
    expect(snapshots).toEqual([["h1", { turns: 40, beforeTurn: 50, bytes: 2_000_000, imagesByUrl: true }]]);
    // Inside a turn that came in part: the offset goes along, and needs a turn.
    await dispatch(chats, phone(), "chat.snapshot", { handle: "h1", before: 50, offset: 3, turns: 20 });
    expect(snapshots[1]).toEqual(["h1", { turns: 20, beforeTurn: 50, offset: 3, bytes: 2_000_000, imagesByUrl: true }]);
    expect(() => dispatch(chats, phone(), "chat.snapshot", { handle: "h1", offset: 3 })).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => dispatch(chats, phone(), "chat.snapshot", { handle: "h1", before: 50, offset: 1.5 })).toThrow(expect.objectContaining({ code: "bad_request" }));
    // A smaller page than the host's own (the phone's first), never a bigger one.
    await dispatch(chats, phone(), "chat.snapshot", { handle: "h1", turns: 6, bytes: 256_000 });
    expect(snapshots[2]).toEqual(["h1", { turns: 6, bytes: 256_000, imagesByUrl: true }]);
    // The window's pages count images as their bytes: they cross IPC inline.
    await dispatch(chats, desktop(), "chat.snapshot", { handle: "h1", before: 50 });
    expect(snapshots[3]).toEqual(["h1", { turns: 40, beforeTurn: 50, bytes: 2_000_000 }]);
    expect(() => dispatch(chats, phone(), "chat.snapshot", { handle: "h1", bytes: 2_000_001 })).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => dispatch(chats, phone(), "chat.snapshot", { handle: "h1", bytes: 0 })).toThrow(expect.objectContaining({ code: "bad_request" }));
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

describe("a phone's chat links", () => {
  // The escapes go through a directory junction: Windows creates one without the symlink privilege
  // that a file symlink needs, and elsewhere the type is ignored and it is a plain directory symlink.
  it("open only the files of the chat's directory and project, symlinks followed", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await realpath(await mkdtemp(join(tmpdir(), "pigna-links-")));
    const project = join(base, "project");
    const { worktreeCwd } = await import("../shared/board");
    const worktree = worktreeCwd(join(base, "home"), "abc123", project);
    const outside = join(base, "outside", "secret.txt");
    await mkdir(worktree, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(join(base, "outside"));
    await writeFile(join(project, "README.md"), "# hi");
    await writeFile(join(worktree, "notes.md"), "notes");
    await writeFile(join(worktree, "shot.png"), "png");
    await writeFile(outside, "secret");
    await symlink(join(base, "outside"), join(worktree, "escape"), "junction");

    const opened: unknown[] = [];
    const links = createHostCore({
      ...deps,
      host: { cwdOf: (handle: string) => (handle === "h1" ? worktree : undefined), stateOf: () => undefined },
      browser: () => ({ openPreview: async (path: string, options: unknown) => (opened.push([path, options]), { id: "tab1" }) }),
    } as unknown as HostDeps);

    const resolved = await dispatch(links, phone(), "chat.resolveLinks", { handle: "h1", targets: ["notes.md", join(project, "README.md"), outside, join("escape", "secret.txt"), "/etc/hosts", "missing.md"] });
    expect(resolved).toEqual([join(worktree, "notes.md"), join(project, "README.md"), null, null, null, null]);
    await expect(dispatch(links, phone(), "chat.linkImage", { handle: "h1", target: "shot.png" })).resolves.toMatchObject({ mimeType: "image/png" });
    await expect(dispatch(links, phone(), "chat.linkImage", { handle: "h1", target: outside })).resolves.toBeNull();

    await expect(dispatch(links, phone(), "chat.openFile", { handle: "h1", path: join(worktree, "notes.md"), line: 3 })).resolves.toEqual({ id: "tab1" });
    expect(opened).toEqual([[join(worktree, "notes.md"), { agent: "h1", root: worktree, line: 3 }]]);
    await expect(dispatch(links, phone(), "chat.openFile", { handle: "h1", path: join(worktree, "escape", "secret.txt") })).rejects.toMatchObject({ code: "scope_denied" });
    await expect(dispatch(links, phone(), "chat.openFile", { handle: "h1", path: outside })).rejects.toMatchObject({ code: "scope_denied" });
    expect(opened).toHaveLength(1);
    await expect(dispatch(links, phone(), "chat.resolveLinks", { handle: "gone", targets: [] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("load the images the chat's answers embed wherever they are, and nothing else outside its folders", async () => {
    const { mkdtemp, mkdir, writeFile, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await realpath(await mkdtemp(join(tmpdir(), "pigna-shown-")));
    const cwd = join(base, "chat");
    const shots = join(base, "shots");
    await mkdir(cwd);
    await mkdir(shots);
    for (const name of ["shown.png", "raw.png", "other.png", "asked.png", "draft.png"]) await writeFile(join(shots, name), "png");
    await writeFile(join(shots, "notes.txt"), "secret");
    const answer = (text: string, streaming = false) => ({ kind: "assistant", streaming, message: { role: "assistant", content: [{ type: "text", text }] } });
    const items = [
      { kind: "user", message: { role: "user", content: `Show ![](${join(shots, "asked.png")})` } },
      answer(`Done:\n\n![listed](${join(shots, "shown.png")})\n\n<img src="${join(shots, "raw.png")}">\n\n![](${join(shots, "notes.txt")}) and [a link](${join(shots, "other.png")})`),
      answer(`\`![](${join(shots, "draft.png")})\``),
    ];
    const core = createHostCore({ ...deps, host: { cwdOf: () => cwd, stateOf: () => ({ items }) } } as unknown as HostDeps);
    const image = (target: string, from?: string) => dispatch(core, phone(), "chat.linkImage", { handle: "h1", target, from });

    const targets = ["shown.png", "raw.png", "notes.txt", "other.png", "asked.png", "draft.png"].map((name) => join(shots, name));
    await expect(dispatch(core, phone(), "chat.resolveLinks", { handle: "h1", targets })).resolves.toEqual([targets[0], targets[1], null, null, null, null]);
    await expect(image(join(shots, "shown.png"))).resolves.toMatchObject({ mimeType: "image/png" });
    await expect(image(`file://${join(shots, "raw.png")}`)).resolves.toMatchObject({ mimeType: "image/png" });
    // Embedded but not an image, only linked, embedded by the user's message, or in code: still confined.
    for (const name of ["notes.txt", "other.png", "asked.png", "draft.png"]) await expect(image(join(shots, name))).resolves.toBeNull();
    // A file the chat shows resolves its own images inside the folders only.
    await expect(dispatch(core, phone(), "chat.resolveLinks", { handle: "h1", targets: [join(shots, "shown.png")], from: cwd })).resolves.toEqual([null]);
    await expect(image(join(shots, "shown.png"), cwd)).resolves.toBeNull();
  });

  it("read a file of the chat's folders as text for the phone to draw, and resolve its links from its own folder", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PREVIEW_LIMITS } = await import("../shared/preview");
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pigna-read-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "pigna-outside-")));
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs", "guide.md"), "# Guide\n\nSee [setup](setup.md).");
    await writeFile(join(cwd, "docs", "setup.md"), "setup");
    await writeFile(join(cwd, "docs", "shot.png"), "png");
    await writeFile(join(cwd, "LICENSE"), "MIT");
    await writeFile(join(cwd, "blob.bin"), Buffer.from([0x89, 0x50, 0, 1]));
    await writeFile(join(cwd, "big.txt"), "x".repeat(PREVIEW_LIMITS.text + 10));
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(cwd, "escape"), "junction");
    const core = createHostCore({ ...deps, host: { cwdOf: (handle: string) => (handle === "h1" ? cwd : undefined) } } as unknown as HostDeps);
    const read = (path: string) => dispatch(core, phone(), "chat.readFile", { handle: "h1", path });

    await expect(read(join(cwd, "docs", "guide.md"))).resolves.toEqual({ path: join(cwd, "docs", "guide.md"), name: "guide.md", kind: "markdown", size: 31, text: "# Guide\n\nSee [setup](setup.md).", truncated: false });
    await expect(read(join(cwd, "LICENSE"))).resolves.toMatchObject({ kind: "text", text: "MIT" });
    await expect(read(join(cwd, "blob.bin"))).resolves.toMatchObject({ kind: "other", text: undefined });
    const big = (await read(join(cwd, "big.txt"))) as { text: string; truncated: boolean; size: number };
    expect([big.text.length, big.truncated, big.size]).toEqual([PREVIEW_LIMITS.text, true, PREVIEW_LIMITS.text + 10]);
    await expect(read(join(cwd, "escape", "secret.md"))).rejects.toMatchObject({ code: "scope_denied" });
    await expect(read(join(outside, "secret.md"))).rejects.toMatchObject({ code: "scope_denied" });
    await expect(read(join(cwd, "missing.md"))).rejects.toMatchObject({ code: "scope_denied" });
    // dispatch checks the arguments before it returns a promise.
    expect(() => read("relative.md")).toThrow("Invalid file path");

    const docs = join(cwd, "docs");
    await expect(dispatch(core, phone(), "chat.resolveLinks", { handle: "h1", targets: ["setup.md", "../LICENSE"], from: docs })).resolves.toEqual([join(docs, "setup.md"), join(cwd, "LICENSE")]);
    await expect(dispatch(core, phone(), "chat.linkImage", { handle: "h1", target: "shot.png", from: docs })).resolves.toMatchObject({ mimeType: "image/png" });
    await expect(dispatch(core, phone(), "chat.resolveLinks", { handle: "h1", targets: ["secret.md"], from: outside })).rejects.toMatchObject({ code: "scope_denied" });
  });
});
