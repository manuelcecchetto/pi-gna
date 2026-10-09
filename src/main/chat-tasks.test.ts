import { describe, expect, it, vi } from "vitest";
import { applyOp, type Board, type BoardOp, emptyBoard } from "../shared/board";
import type { CardWorktree } from "../shared/ipc";
import type { Lament } from "../shared/laments";
import type { RpcCommand } from "../shared/protocol";
import type { RunOutcome } from "../shared/session-state";
import { emptySettings } from "../shared/settings";
import { ChatTasks, type ChatTasksDeps } from "./chat-tasks";

const client = { clientId: "c1", actor: "d1" } as const;
const worktree: CardWorktree = { cwd: "/home/.pi-gna/worktrees/aaaaaa/repo", branch: "pigna/aaaaaa-fix-the-flash", created: true, dirty: false };
const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-5-5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
];

/** A SessionHost that records what it is asked, and lets a test settle a chat's run. */
function fakeHost(options: { models?: unknown[]; failPrompt?: boolean; noFile?: boolean; failCommand?: RpcCommand["type"]; switchedModel?: unknown } = {}) {
  const log: { handle: string; command: RpcCommand }[] = [];
  const opened: { cwd: string; lease: unknown }[] = [];
  const holds = new Set<string>();
  const viewing = new Set<string>();
  const closed: string[] = [];
  const settle: ((handle: string, outcome: RunOutcome) => void)[] = [];
  const cwds = new Map<string, string>();
  let n = 0;
  const host = {
    open: vi.fn(async (request: { cwd: string }, lease?: { hold?: string; client?: unknown }) => {
      const handle = `chat${++n}`;
      opened.push({ cwd: request.cwd, lease });
      cwds.set(handle, request.cwd);
      if (lease?.hold) holds.add(lease.hold);
      return { handle, entries: [] };
    }),
    command: vi.fn(async (handle: string, command: RpcCommand) => {
      log.push({ handle, command });
      if (command.type === options.failCommand) return { type: "response", command: command.type, success: false, error: "selection rejected" };
      if (command.type === "set_model") return { type: "response", command: command.type, success: true, data: options.switchedModel ?? { provider: command.provider, id: command.modelId } };
      if (command.type === "get_available_models") return { type: "response", command: command.type, success: true, data: { models: options.models ?? MODELS } };
      if (command.type === "prompt" && options.failPrompt) return { type: "response", command: command.type, success: false, error: "no api key" };
      return { type: "response", command: command.type, success: true, data: {} };
    }),
    identify: vi.fn(async (handle: string) => {
      if (options.noFile) throw new Error("no session file");
      return { path: `/s/${handle}.jsonl`, cwd: cwds.get(handle) ?? "/repo" };
    }),
    stateOf: vi.fn(() => ({ model: { provider: "anthropic" } })),
    presence: vi.fn((handle: string) => (viewing.has(handle) ? [{ clientId: "w", actor: "desktop", viewing: true }] : [])),
    release: vi.fn((_handle: string, hold: string) => void holds.delete(hold)),
    close: vi.fn(async (handle: string) => void closed.push(handle)),
    snapshot: vi.fn((handle: string) => ({ seq: 3, state: { handle }, turns: { total: 0, from: 0 } })),
    onSettled: (listener: (handle: string, outcome: RunOutcome) => void) => void settle.push(listener),
    onExit: () => undefined,
    attentionAll: vi.fn((): { handle: string; sessionPath?: string }[] => []),
  };
  return { host, log, opened, holds, viewing, closed, settle: (handle: string, outcome: RunOutcome = "done") => settle.forEach((listener) => listener(handle, outcome)) };
}

const ops: BoardOp[] = [
  { type: "add", id: "aaaaaa", title: "Fix the flash", notes: "It flashes", cwd: "/repo", before: null },
  { type: "add", id: "bbbbbb", title: "Ship it", cwd: "/repo", column: "in_review", before: null },
  { type: "attach", id: "bbbbbb", chat: { path: "/s/r.jsonl", cwd: "/home/.pi-gna/worktrees/bbbbbb/repo" } },
];
const lament = { id: "llllll", title: "No tab recorder", cwd: "/repo", reports: [{ at: 1, text: "x", severity: "costly" }] } as unknown as Lament;

function setup(hostOptions: Parameters<typeof fakeHost>[0] = {}, git: () => Promise<CardWorktree | null> = async () => worktree, saveImage?: () => Promise<string>) {
  const fake = fakeHost(hostOptions);
  let board: Board = ops.reduce((current, op, index) => applyOp(current, op, index), emptyBoard());
  const applied: BoardOp[] = [];
  const laments: unknown[] = [];
  const saved: string[] = [];
  const worktrees: { project: string; id: string }[] = [];
  const deps: ChatTasksDeps = {
    host: fake.host as never,
    board: {
      get: async () => board,
      apply: async (op) => {
        applied.push(op);
        board = applyOp(board, op, 100 + applied.length);
        return board;
      },
    },
    laments: { get: async () => ({ laments: [lament] }), apply: async (op) => void laments.push(op) },
    settings: { get: async () => emptySettings() },
    cardImages: { save: async (card, image) => (saveImage ? saveImage() : (saved.push(image.mimeType), `/images/${card}/${saved.length}.png`)) },
    worktree: async (project, task) => (worktrees.push({ project, id: task.id }), git()),
    shellEnv: Promise.resolve(),
  };
  return { tasks: new ChatTasks(deps), ...fake, applied, laments, saved, worktrees, board: () => board };
}

const types = (log: { command: RpcCommand }[]) => log.map((entry) => entry.command.type);
const prompt = (log: { command: RpcCommand }[]) => log.map((entry) => entry.command).findLast((command) => command.type === "prompt") as { message: string } | undefined;

describe("starting a task's chat on the host", () => {
  it("investigates a card: attached to it by its session file, prompted, then named", async () => {
    const s = setup();
    const started = await s.tasks.start(client, { kind: "investigate", card: "aaaaaa" });
    expect(started).toMatchObject({ handle: "chat1", snapshot: { seq: 3 }, notices: [{ level: "info", text: "Investigating “Fix the flash” in a new chat" }] });
    expect(s.opened).toEqual([{ cwd: "/repo", lease: { hold: expect.stringMatching(/^task:/) } }]);
    expect(s.applied).toEqual([{ type: "attach", id: "aaaaaa", chat: { path: "/s/chat1.jsonl", cwd: "/repo", label: "Investigate: Fix the flash" } }]);
    expect(types(s.log)).toEqual(["get_state", "prompt", "set_session_name"]);
    expect(prompt(s.log)?.message).toMatch(/^Investigate this card/);
    expect(s.log.at(-1)?.command).toEqual({ type: "set_session_name", name: "Investigate: Fix the flash" });
  });

  it("holds the chat until its run settles, then lets go; a failed run stays open", async () => {
    const s = setup();
    await s.tasks.start(client, { kind: "investigate", card: "aaaaaa" });
    expect(s.holds.size).toBe(1);
    s.settle("chat1", "error");
    expect(s.holds.size).toBe(0);
    expect(s.closed).toEqual([]);
  });

  it("works in the card's worktree for Resolve and tells the caller about it", async () => {
    const s = setup({}, async () => ({ ...worktree, dirty: true }));
    const started = await s.tasks.start(client, { kind: "resolve", card: "aaaaaa" });
    expect(s.worktrees).toEqual([{ project: "/repo", id: "aaaaaa" }]);
    expect(s.opened[0]?.cwd).toBe(worktree.cwd);
    expect(prompt(s.log)?.message).toContain("on branch pigna/aaaaaa-fix-the-flash");
    expect(started.notices).toEqual([{ level: "warning", text: expect.stringContaining("uncommitted changes are not in its worktree") }]);
  });

  it("works in the project folder when the project is not in git", async () => {
    const s = setup({}, async () => null);
    const started = await s.tasks.start(client, { kind: "resolve", card: "aaaaaa" });
    expect(s.opened[0]?.cwd).toBe("/repo");
    expect(prompt(s.log)?.message).not.toContain("worktree");
    expect(started.notices[0]).toMatchObject({ level: "info", text: expect.stringContaining("not in a git repository") });
  });

  it("starts no chat when git fails", async () => {
    const s = setup({}, async () => Promise.reject(new Error("git worktree failed")));
    await expect(s.tasks.start(client, { kind: "resolve", card: "aaaaaa" })).rejects.toThrow("Could not make a git worktree for “Fix the flash”: git worktree failed");
    expect(s.opened).toEqual([]);
  });

  it("checks in review where the change is: the card's worktree if a chat worked there, else the project folder", async () => {
    const there = setup();
    await there.tasks.start(client, { kind: "qa", card: "bbbbbb" });
    expect(there.worktrees).toEqual([{ project: "/repo", id: "bbbbbb" }]);
    expect(there.opened[0]?.cwd).toBe(worktree.cwd);
    const here = setup();
    await here.tasks.start(client, { kind: "qa", card: "aaaaaa" });
    expect(here.worktrees).toEqual([]);
    expect(here.opened[0]?.cwd).toBe("/repo");
    expect(prompt(here.log)?.message).toContain("The change was made in the project folder");
  });

  it("fixes a lament in its worktree and records the chat and branch on the lament, before the prompt", async () => {
    const s = setup();
    await s.tasks.start(client, { kind: "fix", lament: "llllll" });
    expect(s.worktrees).toEqual([{ project: "/repo", id: "llllll" }]);
    expect(s.laments).toEqual([{ type: "fix", id: "llllll", chat: { path: "/s/chat1.jsonl", cwd: worktree.cwd }, branch: worktree.branch }]);
    expect(prompt(s.log)?.message).toMatch(/^Fix the gap this lament/);
    expect(s.log.at(-1)?.command).toEqual({ type: "set_session_name", name: "Fix: No tab recorder" });
    expect(s.applied).toEqual([]);
  });

  it("reviews a pull request in the project, with the page's account", async () => {
    const s = setup();
    const item = { kind: "pr", number: 7, title: "Fix the login", state: "open", author: "octocat", labels: [], createdAt: "", updatedAt: "", url: "https://github.com/acme/app/pull/7", body: "" } as const;
    await s.tasks.start(client, { kind: "review", cwd: "/repo", repo: { host: "github.com", repo: "acme/app" }, item: { ...item, labels: [] }, login: "work-me" });
    expect(s.opened[0]?.cwd).toBe("/repo");
    expect(prompt(s.log)?.message).toContain('gh auth token --hostname github.com --user work-me');
    expect(s.log.at(-1)?.command).toEqual({ type: "set_session_name", name: "Review PR #7: Fix the login" });
    await expect(s.tasks.start(client, { kind: "review", cwd: "repo", repo: { host: "h", repo: "r" }, item } as never)).rejects.toThrow("a review needs");
  });

  it("opens a chat for 'Chat about it' leased to the caller, with nothing sent", async () => {
    const s = setup();
    await s.tasks.start(client, { kind: "discuss", card: "aaaaaa" });
    expect(s.opened).toEqual([{ cwd: "/repo", lease: { client } }]);
    expect(s.log).toEqual([]);
  });

  it("warns, and still sends the prompt, when the chat has no session file", async () => {
    const s = setup({ noFile: true });
    const started = await s.tasks.start(client, { kind: "investigate", card: "aaaaaa" });
    expect(started.notices).toContainEqual({ level: "warning", text: "This chat has no session file, so pi-gna cannot link to it" });
    expect(prompt(s.log)).toBeDefined();
  });

  it("leaves the chat open and says so when pi refuses the prompt", async () => {
    const s = setup({ failPrompt: true });
    const started = await s.tasks.start(client, { kind: "investigate", card: "aaaaaa" });
    expect(started.notices.at(-1)).toEqual({ level: "warning", text: "Could not set up “Investigate: Fix the flash”: no api key" });
    expect(s.holds.size).toBe(0);
    expect(s.closed).toEqual([]);
  });
});

describe("a card's triage", () => {
  const settled = async (s: ReturnType<typeof setup>) => {
    await s.tasks.addCard("/repo", "todo", "fix the flash");
    await vi.waitFor(() => expect(types(s.log)).toContain("set_session_name"));
  };

  it("starts when a card is added, on the triage model, named so the sidebar never lists it", async () => {
    const s = setup();
    const { id } = await s.tasks.addCard("/repo", "todo", "  fix the flash  ");
    expect(s.board().cards.find((card) => card.id === id)).toMatchObject({ title: "fix the flash", notes: "fix the flash", column: "todo" });
    await vi.waitFor(() => expect(types(s.log)).toContain("set_session_name"));
    expect(types(s.log)).toEqual(["get_state", "get_available_models", "set_model", "set_thinking_level", "prompt", "set_session_name"]);
    expect(s.log.find((entry) => entry.command.type === "set_model")?.command).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(prompt(s.log)?.message).toMatch(/^Triage this new card/);
    expect(s.log.at(-1)?.command).toEqual({ type: "set_session_name", name: "Triage: fix the flash" });
    expect(s.applied.map((op) => op.type)).toEqual(["add", "attach"]);
  });

  it("closes once its run ends well and nobody is looking", async () => {
    const s = setup();
    await settled(s);
    s.settle("chat1", "done");
    expect(s.closed).toEqual(["chat1"]);
  });

  it("stays open when someone is looking at it", async () => {
    const s = setup();
    await settled(s);
    s.viewing.add("chat1");
    s.settle("chat1", "done");
    expect(s.closed).toEqual([]);
    expect(s.holds.size).toBe(0);
  });

  it("stays open, marked, when its run fails", async () => {
    const s = setup();
    await settled(s);
    s.settle("chat1", "error");
    expect(s.closed).toEqual([]);
    expect(s.holds.size).toBe(0);
  });

  it("does not send the triage prompt when its model is unavailable", async () => {
    const s = setup({ models: [] });
    const started = await s.tasks.start(client, { kind: "triage", card: "aaaaaa" });
    expect(started.notices).toContainEqual({ level: "warning", text: expect.stringContaining("claude-sonnet-5-5 is not available") });
    expect(types(s.log)).not.toContain("set_model");
    expect(prompt(s.log)).toBeUndefined();
    expect(s.holds.size).toBe(0);
  });

  it("is not started for a card with nothing to say", async () => {
    const s = setup();
    await expect(s.tasks.addCard("/repo", "todo", "  ")).rejects.toThrow("needs a description");
    expect(s.opened).toEqual([]);
  });
});

describe("ATP worker model selection", () => {
  const model = { provider: "openai-codex", id: "gpt-6-luna", thinking: "high" as const };
  const worker = { cwd: "/repo", atp: { role: "worker" as const, plan: "/repo/plan.atp.json", node: "T13" }, name: "ATP T13", prompt: "Work T13", model };

  it("selects the exact provider/model and thinking before sending the worker prompt", async () => {
    const s = setup({ models: [model] });
    expect(await s.tasks.launch(worker)).toEqual({ handle: "chat1", failed: undefined });
    expect(s.log.map((entry) => entry.command)).toEqual([
      { type: "get_state" }, { type: "get_available_models" },
      { type: "set_model", provider: "openai-codex", modelId: "gpt-6-luna" },
      { type: "set_thinking_level", level: "high" },
      { type: "prompt", message: "Work T13" }, { type: "set_session_name", name: "ATP T13" },
    ]);
  });

  it("does not substitute another provider serving the same model id", async () => {
    const s = setup({ models: [{ ...model, provider: "other" }] });
    const started = await s.tasks.launch(worker);
    expect(started.failed).toContain("openai-codex/gpt-6-luna is not available");
    expect(prompt(s.log)).toBeUndefined();
    expect(s.holds.size).toBe(0);
  });

  it.each(["get_available_models", "set_model", "set_thinking_level"] as const)("stops before the prompt if %s fails", async (failCommand) => {
    const s = setup({ models: [model], failCommand });
    const started = await s.tasks.launch(worker);
    expect(started.failed).toContain("selection rejected");
    expect(started.failed).toContain(failCommand);
    expect(prompt(s.log)).toBeUndefined();
    expect(s.holds.size).toBe(0);
  });

  it.each([
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "other", id: "gpt-6-luna" },
    {},
  ])("rejects an unconfirmed or mismatched model switch: %j", async (switchedModel) => {
    const s = setup({ models: [model], switchedModel });
    const started = await s.tasks.launch(worker);
    expect(started.failed).toContain("did not confirm openai-codex/gpt-6-luna");
    expect(prompt(s.log)).toBeUndefined();
    expect(s.holds.size).toBe(0);
  });
});

describe("a new card's attachments", () => {
  const image = { kind: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
  const file = { kind: "file" as const, path: "/docs/spec.pdf" };

  it("saves the images for the new card, then lists them in its notes with the files, then triages it", async () => {
    const s = setup();
    const { id } = await s.tasks.addCard("/repo", "todo", "", [image, file]);
    const card = s.board().cards.find((other) => other.id === id);
    expect(card?.title).toBe("See the attachments");
    expect(card?.notes).toBe(`Attachments:\n- /images/${id}/1.png\n- /docs/spec.pdf`);
    expect(s.applied.map((op) => op.type).slice(0, 2)).toEqual(["add", "edit"]);
    await vi.waitFor(() => expect(prompt(s.log)?.message).toContain("Read the files under Attachments"));
  });

  it("takes the card off the board again when an image cannot be saved, so you can retry", async () => {
    const s = setup({}, undefined, () => Promise.reject(new Error("the image is too large (30 MB)")));
    await expect(s.tasks.addCard("/repo", "todo", "Look at this", [image])).rejects.toThrow("Could not attach that to the card: the image is too large (30 MB)");
    expect(s.applied.map((op) => op.type)).toEqual(["add", "remove"]);
    expect(s.board().cards.map((card) => card.title)).not.toContain("Look at this");
    expect(s.opened).toEqual([]);
  });
});

describe("sending to a chat about a card", () => {
  it("sends the card's details before the message and joins the chat to the card; a command does neither", async () => {
    const s = setup();
    expect(await s.tasks.send("chat1", "/compact", "send", "aaaaaa")).toEqual({ accepted: true });
    expect(prompt(s.log)?.message).toBe("/compact");
    expect(s.applied).toEqual([]);
    expect(await s.tasks.send("chat1", "Why does it flash?", "send", "aaaaaa")).toEqual({ accepted: true });
    expect(s.log.map((entry) => entry.command).findLast((command) => command.type === "prompt")).toMatchObject({ message: expect.stringMatching(/^<kanban-card>\nCard aaaaaa[^]*<\/kanban-card>\n\nWhy does it flash\?$/) });
    expect(s.applied).toEqual([{ type: "attach", id: "aaaaaa", chat: { path: "/s/chat1.jsonl", cwd: "/repo" } }]);
  });

  it("composes the file mention block and image content from attachments, but not for a command", async () => {
    const s = setup();
    const attachments = [
      { path: "/u/a/photo.jpg", name: "photo.jpg", isDir: false, image: { mimeType: "image/jpeg", data: "QUJD" } },
      { path: "/u/a/notes.txt", name: "notes.txt", isDir: false },
    ];
    await s.tasks.send("chat1", "see these", "send", undefined, attachments);
    expect(prompt(s.log)).toMatchObject({
      message: "see these\n\n# Files mentioned by the user:\n\n## photo.jpg: /u/a/photo.jpg (image attached)\n## notes.txt: /u/a/notes.txt",
      images: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }],
    });
    await s.tasks.send("chat1", "/compact", "send", undefined, attachments);
    expect(prompt(s.log)).toEqual(expect.objectContaining({ message: "/compact", images: undefined }));
  });

  it("composes a phone's browser comments and their crops after the text, but not for a command", async () => {
    const s = setup();
    const note = { id: "a", url: "http://localhost:3000/", title: "App", selector: "#go", label: 'button "Go"', html: "<button>Go</button>", comment: "too small", image: "QUJD" };
    await s.tasks.send("chat1", "fix this", "send", undefined, [], [note]);
    expect(prompt(s.log)).toMatchObject({ message: expect.stringMatching(/^fix this\n\n<browser-comments>[^]*1\. too small[^]*<\/browser-comments>$/), images: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }] });
    await s.tasks.send("chat1", "/compact", "send", undefined, [], [note]);
    expect(prompt(s.log)).toEqual(expect.objectContaining({ message: "/compact", images: undefined }));
  });

  it("queues behind a running turn as asked", async () => {
    const s = setup();
    s.host.stateOf.mockReturnValue({ running: true } as never);
    await s.tasks.send("chat1", "more", "followUp");
    expect(prompt(s.log)).toMatchObject({ message: "more", streamingBehavior: "followUp" });
  });
});

describe("a message from another thread", () => {
  const thread = { path: "/s/t.jsonl", cwd: "/repo" };

  it("prompts an open idle thread at once, and a running one as the sender chose", async () => {
    const s = setup();
    s.host.attentionAll.mockReturnValue([{ handle: "live", sessionPath: "/s/t.jsonl" }]);
    expect(await s.tasks.message(thread, "hi", "steer")).toBe("started");
    expect(s.log.at(-1)).toEqual({ handle: "live", command: { type: "prompt", message: "hi" } });
    s.host.stateOf.mockReturnValue({ running: true } as never);
    expect(await s.tasks.message(thread, "more", "steer")).toBe("steer");
    expect(s.log.at(-1)?.command).toEqual({ type: "prompt", message: "more", streamingBehavior: "steer" });
    expect(s.opened).toEqual([]);
  });

  it("opens a closed thread in the background, held until that run ends", async () => {
    const s = setup();
    expect(await s.tasks.message(thread, "wake up", "followUp")).toBe("opening");
    await vi.waitFor(() => expect(prompt(s.log)?.message).toBe("wake up"));
    expect(s.host.open).toHaveBeenCalledWith({ cwd: "/repo", sessionPath: "/s/t.jsonl" }, { hold: expect.stringMatching(/^thread:/) });
    expect(s.holds.size).toBe(1);
    s.settle("chat1");
    expect(s.holds.size).toBe(0);
    expect(s.closed).toEqual([]);
  });

  it("lets go of a closed thread it could not prompt", async () => {
    const s = setup({ failPrompt: true });
    await s.tasks.message(thread, "wake up", "followUp");
    await vi.waitFor(() => expect(s.holds.size).toBe(0));
  });
});
