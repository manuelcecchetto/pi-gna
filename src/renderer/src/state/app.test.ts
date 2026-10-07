import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSessionResult, SessionSummary } from "../../../shared/ipc";
import type { RpcCommand, RpcSessionState, SessionEntry } from "../../../shared/protocol";
import { createSession, reduceSessionEvent, type SessionState } from "../../../shared/session-state";
import type { Card } from "../../../shared/board";
import type { GithubItem } from "../../../shared/github";
import { cardBlock } from "../../../shared/task-prompts";
import { emptySettings } from "../../../shared/settings";
import {
  activate,
  addCard,
  CARD_TASK_STARTED_MS,
  fixLament,
  applySettings,
  closeSettings,
  composerCard,
  handleBatch,
  interrupt,
  openSession,
  openSettings,
  removeComposerCard,
  respondDialog,
  scopeBrowser,
  reviewPullRequest,
  send,
  sessionTitle,
  showPage,
  showPageChat,
  store,
  togglePage,
} from "./app";
import { cardActions } from "./card-actions";

vi.mock("../lib/layout", () => ({ loadSidebar: () => ({ width: 268, collapsed: false }), saveSidebar: vi.fn() }));
const command = vi.fn(async (_handle: string, cmd: RpcCommand) => ({
  type: "response", command: cmd.type, success: true,
  data: cmd.type === "clear_queue" ? { steering: ["queued steer"], followUp: ["queued follow-up"] } : {},
}));

beforeEach(() => {
  vi.useFakeTimers();
  command.mockClear();
  vi.stubGlobal("window", { studio: { command } });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("interrupt action", () => {
  const hostInterrupt = vi.fn(async (_handle: string) => ["queued steer", "queued follow-up"]);
  beforeEach(() => {
    hostInterrupt.mockClear();
    vi.stubGlobal("window", { studio: { command, interrupt: hostInterrupt } });
  });

  it.each(["manual compaction", "agent run"])("asks the host to interrupt %s and returns the restored queue", async (operation) => {
    const session = operation === "manual compaction"
      ? reduceSessionEvent(createSession("h", "/repo"), { type: "compaction_start", reason: "manual" }, 1000)
      : { ...createSession("h", "/repo"), running: true };
    store.set((s) => ({ ...s, sessions: { h: session } }));
    expect(await interrupt("h")).toEqual(["queued steer", "queued follow-up"]);
    expect(hostInterrupt).toHaveBeenCalledExactlyOnceWith("h");
    expect(command).not.toHaveBeenCalled();
  });

  it("does nothing for an idle or missing session", async () => {
    store.set((s) => ({ ...s, sessions: { h: createSession("h", "/repo") } }));
    expect(await interrupt("h")).toEqual([]);
    expect(await interrupt("missing")).toEqual([]);
    expect(hostInterrupt).not.toHaveBeenCalled();
  });
});

describe("answering a dialog", () => {
  const dialog = { id: "d1", method: "confirm", title: "Run it?" } as unknown as SessionState["dialogs"][number];
  const response = { type: "extension_ui_response", id: "d1", confirmed: true } as const;
  const seed = () => store.set((s) => ({ ...s, toasts: [], sessions: { h: { ...createSession("h", "/repo"), dialogs: [dialog] } } }));

  it("removes the card once the host took the answer, or says it was answered elsewhere", async () => {
    for (const answer of [{ ok: true }, { ok: false, code: "already_answered", message: "" }] as const) {
      seed();
      vi.stubGlobal("window", { studio: { respondDialog: async () => answer } });
      await respondDialog("h", response);
      expect(store.get().sessions.h?.dialogs).toEqual([]);
    }
  });

  it("keeps the card and says so when the answer fails", async () => {
    seed();
    vi.stubGlobal("window", { studio: { respondDialog: async () => ({ ok: false, code: "internal", message: "boom" }) } });
    await respondDialog("h", response);
    expect(store.get().sessions.h?.dialogs).toHaveLength(1);
    expect(store.get().toasts.at(-1)?.text).toContain("boom");
  });

  it("drops the card on dialog_resolved from another client", () => {
    seed();
    handleBatch({ handle: "h", events: [{ kind: "dialog_resolved", id: "d1", by: { device: "phone" }, outcome: "answered" }] });
    expect(store.get().sessions.h?.dialogs).toEqual([]);
  });
});

describe("opening a chat from the sidebar", () => {
  const summary: SessionSummary = { path: "/s/a.jsonl", id: "a", cwd: "/repo", title: "Fix the flash", named: false, createdAt: 0, modifiedAt: 0 };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "fix the flash please", timestamp: 1 } } as SessionEntry;

  it("is loading under the sidebar's title until its history arrives, not an empty chat", async () => {
    let read!: (result: OpenSessionResult) => void;
    const open = vi.fn(() => new Promise<OpenSessionResult>((resolve) => (read = resolve)));
    vi.stubGlobal("window", { studio: { command, openSession: open } });
    openSession(summary);
    const handle = store.get().active ?? "";
    const opened = store.get().sessions[handle];
    expect(opened?.sessionPath).toBe(summary.path);
    expect(opened?.loading).toEqual({ title: "Fix the flash" });
    expect(opened && sessionTitle(opened)).toBe("Fix the flash");

    read({ handle, entries: [entry] });
    await vi.runAllTimersAsync();
    const loaded = store.get().sessions[handle];
    expect(loaded?.loading).toBeUndefined();
    expect(loaded?.items.map((item) => item.kind)).toEqual(["user"]);
    expect(loaded && sessionTitle(loaded)).toBe("fix the flash please");
  });
});

describe("chats the host starts for a task", () => {
  const card: Card = { id: "aaaaaa", title: "Fix the flash", notes: "", tags: [], cwd: "/repo", column: "todo", github: [], chats: [], reports: [], createdAt: 0, updatedAt: 0 };
  const startTask = vi.fn();
  const attachSession = vi.fn(async (handle: string) => ({ seq: 1, state: createSession(handle, "/repo") }));
  const addCardCall = vi.fn();

  beforeEach(() => {
    startTask.mockReset();
    addCardCall.mockReset();
    vi.stubGlobal("window", { studio: { command, startTask, attachSession, addCard: addCardCall, detachSession: async () => undefined } });
    store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined, toasts: [], cardTasks: {} }));
  });

  const run = async (id: string, target = card) => {
    cardActions(target).find((action) => action.id === id)?.run(target);
    await vi.advanceTimersByTimeAsync(100);
  };

  it("asks the host to start a card's chat, says what it reports, and joins it in the background", async () => {
    startTask.mockResolvedValue({ handle: "r1", snapshot: null, notices: [{ level: "warning", text: "Resolving “Fix the flash” on branch pigna/aaaaaa-fix-the-flash. Your checkout's uncommitted changes are not in its worktree." }] });
    await run("resolve");
    expect(startTask).toHaveBeenCalledExactlyOnceWith({ kind: "resolve", card: "aaaaaa" });
    expect(store.get().sessions.r1).toBeDefined();
    expect(store.get().active).toBeUndefined();
    expect(store.get().toasts.at(-1)).toMatchObject({ level: "warning", text: expect.stringContaining("uncommitted changes are not in its worktree") });
  });

  it("starts the other card actions the same way", async () => {
    startTask.mockResolvedValue({ handle: "r1", snapshot: null, notices: [] });
    await run("investigate");
    await run("qa", { ...card, column: "in_review" });
    expect(startTask.mock.calls.map(([target]) => target)).toEqual([
      { kind: "investigate", card: "aaaaaa" },
      { kind: "qa", card: "aaaaaa" },
    ]);
  });

  it("starts one chat however often you click while it starts, and shows it starting, then started for a moment", async () => {
    let answer: (value: unknown) => void = () => undefined;
    startTask.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const resolve = cardActions(card).find((action) => action.id === "resolve");
    resolve?.run(card);
    resolve?.run(card); // a double click
    expect(store.get().cardTasks).toEqual({ aaaaaa: { resolve: "starting" } });
    // Another task on the card is a chat of its own.
    startTask.mockResolvedValueOnce({ handle: "i1", snapshot: null, notices: [] });
    await run("investigate");
    expect(startTask).toHaveBeenCalledTimes(2);
    expect(store.get().cardTasks).toEqual({ aaaaaa: { resolve: "starting", investigate: "started" } });
    answer({ handle: "r1", snapshot: null, notices: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(startTask.mock.calls.map(([target]) => target)).toEqual([
      { kind: "resolve", card: "aaaaaa" },
      { kind: "investigate", card: "aaaaaa" },
    ]);
    expect(store.get().cardTasks).toEqual({ aaaaaa: { resolve: "started", investigate: "started" } });
    await vi.advanceTimersByTimeAsync(CARD_TASK_STARTED_MS);
    expect(store.get().cardTasks).toEqual({});
    // Started, it can be started again: a second chat on purpose.
    startTask.mockResolvedValueOnce({ handle: "r2", snapshot: null, notices: [] });
    await run("resolve");
    expect(startTask).toHaveBeenCalledTimes(3);
  });

  it("shows the host's failure, such as git not making a worktree, and joins no chat", async () => {
    startTask.mockRejectedValue(new Error("Error invoking remote method 'studio:start-task': Error: Could not make a git worktree for “Fix the flash”: git worktree failed"));
    await run("resolve");
    expect(store.get().sessions).toEqual({});
    expect(store.get().cardTasks).toEqual({}); // and you can try again
    expect(store.get().toasts.at(-1)).toEqual(expect.objectContaining({ level: "error", text: "Could not make a git worktree for “Fix the flash”: git worktree failed" }));
  });

  it("shows a review chat, and a lament's fix chat in the background", async () => {
    startTask.mockResolvedValueOnce({ handle: "p1", snapshot: null, notices: [] }).mockResolvedValueOnce({ handle: "f1", snapshot: null, notices: [] });
    const repo = { host: "github.com", repo: "acme/app" };
    const item = { kind: "pr", number: 7, title: "Fix", state: "open", author: "me", labels: [], createdAt: "", updatedAt: "", url: "u", body: "" } satisfies GithubItem;
    reviewPullRequest("/repo", repo, item, "me");
    await vi.advanceTimersByTimeAsync(100);
    expect(startTask).toHaveBeenLastCalledWith({ kind: "review", cwd: "/repo", repo, item, login: "me" });
    expect(store.get().active).toBe("p1");
    void fixLament({ id: "llllll" } as never);
    await vi.advanceTimersByTimeAsync(100);
    expect(startTask).toHaveBeenLastCalledWith({ kind: "fix", lament: "llllll" });
    expect(store.get().sessions.f1).toBeDefined();
    expect(store.get().active).toBe("p1");
  });

  it("offers QA for cards in review only", () => {
    const ids = (column: Card["column"]) => cardActions({ ...card, column }).map((action) => action.id);
    expect(ids("in_review")).toEqual(["investigate", "resolve", "qa", "discuss"]);
    for (const column of ["todo", "in_progress", "done"] as const) expect(ids(column)).not.toContain("qa");
  });

  const image = { id: "a1", kind: "image" as const, name: "image.png", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const file = { id: "a2", kind: "file" as const, name: "spec.pdf", path: "/docs/spec.pdf", isDir: false };

  it("hands a new card, with what you attached, to the host, which saves it and triages it", async () => {
    addCardCall.mockResolvedValue({ id: "eeeeee" });
    expect(await addCard("/repo", "todo", "  fix the flash ", [image, file])).toBe(true);
    expect(addCardCall).toHaveBeenCalledExactlyOnceWith("/repo", "todo", "fix the flash", [
      { kind: "image", mimeType: "image/png", data: image.data },
      { kind: "file", path: "/docs/spec.pdf" },
    ]);
    expect(await addCard("/repo", "todo", "  ")).toBe(false);
    expect(addCardCall).toHaveBeenCalledTimes(1);
  });

  it("says why a card could not be added, so you can retry", async () => {
    addCardCall.mockRejectedValue(new Error("Error invoking remote method 'studio:add-card': Error: Could not attach that to the card: the image is too large (30 MB)"));
    expect(await addCard("/repo", "todo", "Look at this", [image])).toBe(false);
    expect(store.get().toasts.at(-1)?.text).toBe("Could not attach that to the card: the image is too large (30 MB)");
  });
});

describe("chatting about a card", () => {
  const card: Card = { id: "bbbbbb", title: "Fix the flash", notes: "It flashes", tags: [], cwd: "/repo", column: "todo", github: [], chats: [], reports: [], createdAt: 0, updatedAt: 0 };
  const apply = vi.fn(async () => undefined);

  /** Click "Chat about it" and let pi start; returns the new chat's handle. */
  async function discuss(): Promise<string> {
    vi.stubGlobal("window", {
      studio: { command, openSession: async () => ({ entries: [] }), listSessions: async () => [], closeSession: async () => undefined, board: { apply } },
    });
    store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined, composerCards: {}, board: { version: 1, cards: [card], rev: 0 } }));
    cardActions(card).find((action) => action.id === "discuss")?.run(card);
    const handle = store.get().active ?? "";
    handleBatch({ handle, events: [{ kind: "ready", state: { sessionFile: "/s/d.jsonl", messageCount: 0 } as RpcSessionState }] });
    await vi.advanceTimersByTimeAsync(100);
    return handle;
  }
  const lastPrompt = () => command.mock.calls.map(([, cmd]) => cmd).findLast((cmd) => cmd.type === "prompt");

  beforeEach(() => apply.mockClear());

  it("keeps the card out of the composer's text, sends its details with your first message and joins it then", async () => {
    const handle = await discuss();
    expect(store.get().sessions[handle]?.editorText).toBeUndefined();
    expect(composerCard(store.get(), handle)).toBe(card);
    expect(apply).not.toHaveBeenCalled();
    // A command is not a message about the card: the card waits for the next one.
    expect(await send(handle, "/compact", "send")).toBe(true);
    expect(lastPrompt()).toMatchObject({ message: "/compact" });
    expect(composerCard(store.get(), handle)).toBe(card);
    expect(await send(handle, "Why does it flash?", "send")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(lastPrompt()).toMatchObject({ message: `${cardBlock(card)}\n\nWhy does it flash?` });
    expect(apply).toHaveBeenCalledExactlyOnceWith({ type: "attach", id: "bbbbbb", chat: { path: "/s/d.jsonl", cwd: "/repo", label: undefined } }, 0);
    expect(composerCard(store.get(), handle)).toBeUndefined();
  });

  it("neither tells the chat about the card nor puts it on the card once you remove it", async () => {
    const handle = await discuss();
    removeComposerCard(handle);
    expect(await send(handle, "Something else", "send")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(lastPrompt()).toMatchObject({ message: "Something else" });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("the Settings page", () => {
  const apply = vi.fn(async () => undefined);
  beforeEach(() => {
    apply.mockClear();
    vi.stubGlobal("window", { studio: { command, launchCwd: "/repo", homeDir: "/home", settings: { apply, get: async () => ({ ...emptySettings(), rev: 0 }) } } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    store.set((s) => ({ ...s, settings: { ...emptySettings(), rev: 0 }, page: undefined, toasts: [], sessions: {}, active: undefined }));
  });

  it("covers the page it was opened from and goes back to it", () => {
    showPage("kanban", "/repo");
    openSettings();
    expect(store.get().page).toMatchObject({ kind: "settings", section: "general", back: { kind: "kanban", cwd: "/repo" } });
    togglePage("settings", "computer");
    expect(store.get().page).toMatchObject({ kind: "settings", section: "computer" });
    togglePage("settings", "computer");
    expect(store.get().page).toMatchObject({ kind: "kanban", cwd: "/repo" });
    togglePage("settings");
    closeSettings();
    expect(store.get().page?.kind).toBe("kanban");
  });

  it("turning a feature off closes its page and keeps it closed", async () => {
    showPage("atp", "/repo");
    openSettings("features");
    expect(await applySettings({ type: "feature", feature: "atp", enabled: false })).toBe(true);
    expect(apply).toHaveBeenCalledWith({ type: "feature", feature: "atp", enabled: false }, 0);
    expect(store.get().page).toMatchObject({ kind: "settings", back: undefined });
    closeSettings();
    expect(store.get().page).toBeUndefined();

    showPage("atp", "/repo");
    expect(store.get().page).toBeUndefined();
    expect(store.get().toasts.at(-1)?.text).toContain("ATP is turned off");

    showPage("laments", "/repo");
    await applySettings({ type: "feature", feature: "laments", enabled: false });
    expect(store.get().page).toBeUndefined();
  });

  it("puts the settings back when main refuses the change", async () => {
    apply.mockRejectedValueOnce(new Error("Error invoking remote method 'settings:apply': SettingsError: no"));
    const before = store.get().settings;
    expect(await applySettings({ type: "theme", theme: "dark" })).toBe(false);
    await vi.runAllTimersAsync();
    expect(store.get().settings).toEqual(before);
  });
});

describe("a chat a page shows beside itself (the ATP side column)", () => {
  it("is the chat the host is told this window looks at while the page is open, and is read", () => {
    const viewing = vi.fn();
    vi.stubGlobal("window", { studio: { command, viewing } });
    const worker: SessionState = { ...createSession("w1", "/repo"), unread: "done" };
    store.set((s) => ({ ...s, sessions: { w1: worker }, active: undefined, page: { kind: "atp", cwd: "/repo" } }));
    showPageChat("w1");
    expect(viewing).toHaveBeenLastCalledWith("w1", true);
    expect(store.get().sessions.w1?.unread).toBeUndefined();
    showPageChat(undefined);
    expect(viewing).toHaveBeenLastCalledWith("w1", false);
  });
});

describe("scopeBrowser", () => {
  const tab = (id: string, agent?: string) => ({ id, url: "", title: id, loading: false, canGoBack: false, canGoForward: false, agent });
  const all = { tabs: [tab("a", "chat1"), tab("b", "chat2"), tab("c", "chat1")], activeId: "b", annotating: false };

  it("shows a chat only its own tabs", () => {
    expect(scopeBrowser(all, "chat1").tabs.map((t) => t.id)).toEqual(["a", "c"]);
    expect(scopeBrowser(all, "chat2").tabs.map((t) => t.id)).toEqual(["b"]);
  });

  it("drops the active tab when it belongs to another chat", () => {
    expect(scopeBrowser(all, "chat1").activeId).toBeUndefined();
    expect(scopeBrowser(all, "chat2").activeId).toBe("b");
  });

  it("shows no tabs without a chat", () => {
    expect(scopeBrowser(all, undefined).tabs).toEqual([]);
  });
});
