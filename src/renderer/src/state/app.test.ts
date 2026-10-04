import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSessionResult, SessionSummary } from "../../../shared/ipc";
import type { RpcCommand, RpcSessionState, SessionEntry } from "../../../shared/protocol";
import { createSession, reduceSessionEvent } from "../../../shared/session-state";
import type { Card } from "../../../shared/board";
import { cardBlock } from "../lib/board";
import { emptySettings } from "../../../shared/settings";
import {
  activate,
  addCard,
  applySettings,
  closeSettings,
  composerCard,
  handleBatch,
  interrupt,
  openSession,
  openSettings,
  removeComposerCard,
  send,
  sessionTitle,
  showPage,
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
  it.each(["manual compaction", "agent run"])("aborts %s through RPC", async (operation) => {
    const session = operation === "manual compaction"
      ? reduceSessionEvent(createSession("h", "/repo"), { type: "compaction_start", reason: "manual" }, 1000)
      : { ...createSession("h", "/repo"), running: true };
    store.set((s) => ({ ...s, sessions: { h: session } }));
    expect(await interrupt("h")).toEqual([]);
    expect(command).toHaveBeenCalledExactlyOnceWith("h", { type: "abort" });
  });

  it("restores queues before aborting manual compaction", async () => {
    const session = reduceSessionEvent(createSession("h", "/repo"), { type: "compaction_start", reason: "manual" }, 1000);
    store.set((s) => ({ ...s, sessions: { h: { ...session, queue: { steering: ["queued steer"], followUp: ["queued follow-up"] } } } }));
    expect(await interrupt("h")).toEqual(["queued steer", "queued follow-up"]);
    expect(command.mock.calls.map(([, cmd]) => cmd.type)).toEqual(["clear_queue", "abort"]);
  });

  it("does nothing for an idle or missing session", async () => {
    store.set((s) => ({ ...s, sessions: { h: createSession("h", "/repo") } }));
    expect(await interrupt("h")).toEqual([]);
    expect(await interrupt("missing")).toEqual([]);
    expect(command).not.toHaveBeenCalled();
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

    read({ entries: [entry] });
    await vi.runAllTimersAsync();
    const loaded = store.get().sessions[handle];
    expect(loaded?.loading).toBeUndefined();
    expect(loaded?.items.map((item) => item.kind)).toEqual(["user"]);
    expect(loaded && sessionTitle(loaded)).toBe("fix the flash please");
  });
});

describe("a card's triage chat", () => {
  const listSessions = vi.fn(async () => []);
  const closeSession = vi.fn(async () => undefined);

  /** Add a card, let its triage chat start and send its prompt in the background; returns the chat's handle. */
  async function triage(): Promise<string> {
    vi.stubGlobal("window", {
      studio: { command, openSession: async () => ({ entries: [] }), listSessions, closeSession, board: { apply: async () => undefined } },
    });
    store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined }));
    expect(await addCard("/repo", "todo", "fix the flash")).toBe(true);
    const handle = store.get().open[0] ?? "";
    handleBatch({ handle, events: [{ kind: "ready", state: { sessionFile: "/s/t.jsonl", messageCount: 0 } as RpcSessionState }] });
    await vi.runAllTimersAsync();
    expect(command.mock.calls.map(([, cmd]) => cmd.type)).toContain("prompt");
    return handle;
  }
  const settle = (handle: string) => handleBatch({ handle, events: [{ kind: "rpc", record: { type: "agent_settled" } }] });

  beforeEach(() => {
    listSessions.mockClear();
    closeSession.mockClear();
  });

  it("is named as a triage before pi confirms it, so the sidebar never lists it", async () => {
    const handle = await triage();
    expect(store.get().sessions[handle]?.name).toBe("Triage: fix the flash");
  });

  it("closes once its run ends well", async () => {
    const handle = await triage();
    settle(handle);
    await vi.runAllTimersAsync();
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(handle);
    expect(store.get().sessions[handle]).toBeUndefined();
  });

  it("stays open and marked when its run fails", async () => {
    const handle = await triage();
    store.set((s) => {
      const session = s.sessions[handle];
      if (!session) return s;
      const failed = { ...session, items: [...session.items, { kind: "notice" as const, key: "n", level: "error" as const, text: "overloaded" }] };
      return { ...s, sessions: { ...s.sessions, [handle]: failed } };
    });
    settle(handle);
    await vi.runAllTimersAsync();
    expect(closeSession).not.toHaveBeenCalled();
    expect(store.get().sessions[handle]?.unread).toBe("error");
  });

  it("stays open once you opened it", async () => {
    const handle = await triage();
    activate(handle);
    settle(handle);
    await vi.runAllTimersAsync();
    expect(closeSession).not.toHaveBeenCalled();
    expect(store.get().sessions[handle]).toBeDefined();
  });
});

describe("resolving a card and checking it in review", () => {
  const card: Card = { id: "aaaaaa", title: "Fix the flash", notes: "", tags: [], cwd: "/repo", column: "todo", github: [], chats: [], reports: [], createdAt: 0, updatedAt: 0 };
  const worktree = { cwd: "/home/.pi-gna/worktrees/aaaaaa/repo", branch: "pigna/aaaaaa-fix-the-flash", created: true, dirty: true };
  const cardWorktree = vi.fn();
  const apply = vi.fn(async () => undefined);

  /** Click the card's action (Resolve by default) and let its chat start; returns the chat, if one started. */
  async function resolve(id = "resolve", target = card) {
    vi.stubGlobal("window", {
      studio: { command, cardWorktree, openSession: async () => ({ entries: [] }), listSessions: async () => [], board: { apply } },
    });
    store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined, toasts: [], board: { version: 1, cards: [target] } }));
    cardActions(target).find((action) => action.id === id)?.run(target);
    // Not long enough for the toast to go.
    await vi.advanceTimersByTimeAsync(100);
    const handle = store.get().open[0];
    if (handle) {
      handleBatch({ handle, events: [{ kind: "ready", state: { sessionFile: "/s/r.jsonl", messageCount: 0 } as RpcSessionState }] });
      await vi.advanceTimersByTimeAsync(100);
    }
    return handle ? store.get().sessions[handle] : undefined;
  }
  const prompt = () => command.mock.calls.map(([, cmd]) => cmd).find((cmd) => cmd.type === "prompt");

  beforeEach(() => {
    cardWorktree.mockReset();
    apply.mockClear();
  });

  it("starts its chat in the card's worktree, attached to the card and told about the branch", async () => {
    cardWorktree.mockResolvedValue(worktree);
    const session = await resolve();
    expect(cardWorktree).toHaveBeenCalledExactlyOnceWith("aaaaaa");
    expect(session?.cwd).toBe(worktree.cwd);
    expect(apply).toHaveBeenCalledWith({ type: "attach", id: "aaaaaa", chat: { path: "/s/r.jsonl", cwd: worktree.cwd, label: "Resolve: Fix the flash" } });
    expect(prompt()).toMatchObject({ message: expect.stringContaining("on branch pigna/aaaaaa-fix-the-flash") });
    expect(store.get().toasts.at(-1)).toMatchObject({ level: "warning", text: expect.stringContaining("uncommitted changes are not in its worktree") });
  });

  it("works in the project folder when the project is not in git", async () => {
    cardWorktree.mockResolvedValue(null);
    expect((await resolve())?.cwd).toBe("/repo");
    expect(prompt()).toMatchObject({ message: expect.not.stringContaining("worktree") });
    expect(store.get().toasts.at(-1)).toMatchObject({ level: "info", text: expect.stringContaining("not in a git repository") });
  });

  it("starts no chat when git fails", async () => {
    cardWorktree.mockRejectedValue(new Error("Error invoking remote method 'studio:card-worktree': Error: git worktree failed: fatal: invalid reference: HEAD"));
    expect(await resolve()).toBeUndefined();
    expect(store.get().toasts.at(-1)).toEqual(
      expect.objectContaining({ level: "error", text: "Could not make a git worktree for “Fix the flash”: git worktree failed: fatal: invalid reference: HEAD" }),
    );
  });

  it("offers QA for cards in review only", () => {
    const ids = (column: Card["column"]) => cardActions({ ...card, column }).map((action) => action.id);
    expect(ids("in_review")).toEqual(["investigate", "resolve", "qa", "discuss"]);
    for (const column of ["todo", "in_progress", "done"] as const) expect(ids(column)).not.toContain("qa");
  });

  it("checks the change in the card's worktree when a chat on the card worked there", async () => {
    cardWorktree.mockResolvedValue({ ...worktree, created: false });
    const reviewed: Card = { ...card, column: "in_review", chats: [{ path: "/s/r.jsonl", cwd: worktree.cwd, at: 0 }] };
    const session = await resolve("qa", reviewed);
    expect(cardWorktree).toHaveBeenCalledExactlyOnceWith("aaaaaa");
    expect(session?.cwd).toBe(worktree.cwd);
    expect(apply).toHaveBeenCalledWith({ type: "attach", id: "aaaaaa", chat: { path: "/s/r.jsonl", cwd: worktree.cwd, label: "QA: Fix the flash" } });
    expect(prompt()).toMatchObject({ message: expect.stringMatching(/^QA this card[^]*The change is on branch pigna\/aaaaaa-fix-the-flash[^]*Do not fix what you find/) });
    expect(store.get().toasts.at(-1)).toMatchObject({ level: "info", text: "Checking “Fix the flash” on branch pigna/aaaaaa-fix-the-flash" });
  });

  it("checks the change in the project folder, making no worktree, when the card was resolved there", async () => {
    const reviewed: Card = { ...card, column: "in_review", chats: [{ path: "/s/r.jsonl", cwd: "/repo", at: 0 }] };
    expect((await resolve("qa", reviewed))?.cwd).toBe("/repo");
    expect(cardWorktree).not.toHaveBeenCalled();
    expect(prompt()).toMatchObject({ message: expect.stringContaining("The change was made in the project folder") });
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
    store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined, composerCards: {}, board: { version: 1, cards: [card] } }));
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
    expect(apply).toHaveBeenCalledExactlyOnceWith({ type: "attach", id: "bbbbbb", chat: { path: "/s/d.jsonl", cwd: "/repo", label: undefined } });
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

describe("adding a card with screenshots", () => {
  const image = { id: "a1", kind: "image" as const, name: "image.png", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const file = { id: "a2", kind: "file" as const, name: "spec.pdf", path: "/docs/spec.pdf", isDir: false };

  function stub(saveImage: (card: string, image: { mimeType: string; data: string }) => Promise<string>) {
    const apply = vi.fn(async (_op: unknown) => undefined);
    vi.stubGlobal("window", {
      studio: { command, openSession: async () => ({ entries: [] }), listSessions: async () => [], closeSession: async () => undefined, board: { apply, saveImage } },
    });
    store.set((s) => ({ ...s, sessions: {}, open: [], active: undefined, toasts: [], board: { version: 1, cards: [] } }));
    return (): string[] => apply.mock.calls.map(([op]) => (op as { type: string }).type);
  }

  it("saves the images for the new card, then lists them in its notes with the files, then triages it", async () => {
    const saveImage = vi.fn(async (card: string) => `/data/card-images/${card}/image-1.png`);
    const ops = stub(saveImage);
    expect(await addCard("/repo", "todo", "", [image, file])).toBe(true);
    const card = store.get().board.cards[0]!;
    expect(saveImage).toHaveBeenCalledExactlyOnceWith(card.id, { mimeType: "image/png", data: image.data });
    expect(card.title).toBe("See the attachments");
    expect(card.notes).toBe(`Attachments:\n- /data/card-images/${card.id}/image-1.png\n- /docs/spec.pdf`);
    expect(ops()).toEqual(["add", "edit"]);
    expect(store.get().open).toHaveLength(1); // the triage chat
  });

  it("takes the card off the board again when an image cannot be saved, so you can retry", async () => {
    const ops = stub(async () => {
      throw new Error("Error invoking remote method 'board:save-image': Error: the image is too large (30 MB)");
    });
    expect(await addCard("/repo", "todo", "Look at this", [image])).toBe(false);
    expect(ops()).toEqual(["add", "remove"]);
    expect(store.get().board.cards).toEqual([]);
    expect(store.get().toasts.at(-1)?.text).toBe("Could not attach that to the card: the image is too large (30 MB)");
    expect(store.get().open).toEqual([]);
  });
});

describe("the Settings page", () => {
  const apply = vi.fn(async () => undefined);
  beforeEach(() => {
    apply.mockClear();
    vi.stubGlobal("window", { studio: { command, launchCwd: "/repo", homeDir: "/home", settings: { apply, get: async () => emptySettings() } } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    store.set((s) => ({ ...s, settings: emptySettings(), page: undefined, toasts: [], sessions: {}, active: undefined }));
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
    expect(apply).toHaveBeenCalledWith({ type: "feature", feature: "atp", enabled: false });
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
