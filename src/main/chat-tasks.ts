// The chats pi-gna starts itself, for any client: a card's triage, Investigate, Resolve and QA, a lament's Fix, a pull
// request's Review, and a new card with its triage. The host holds the chat while it sets it up and while its first
// run goes, so a closed window or a phone going to sleep changes nothing; the client only adopts the chat afterwards.
import { randomUUID } from "node:crypto";
import { type Board, type BoardOp, type Card, freshId, LIMITS } from "../shared/board";
import { type ClientPresence, HostError, type NewCardAttachment, type TaskNotice, type TaskStarted, type TaskTarget } from "../shared/host-api";
import type { CardWorktree, OpenSessionRequest } from "../shared/ipc";
import type { Lament } from "../shared/laments";
import type { Model, RpcCommand, RpcResponse } from "../shared/protocol";
import { type Settings, type TaskModel, taskModel } from "../shared/settings";
import type { RunOutcome } from "../shared/session-state";
import {
  boardTags,
  cardBlock,
  cardNotes,
  draftTitle,
  fixPrompt,
  hasWorktree,
  investigatePrompt,
  pickModel,
  qaPrompt,
  resolvePrompt,
  reviewName,
  reviewPrompt,
  triageName,
  triagePrompt,
} from "../shared/task-prompts";
import { log } from "./log";
import type { SessionHost } from "./session-host";

export interface ChatTasksDeps {
  host: Pick<SessionHost, "open" | "command" | "identify" | "stateOf" | "presence" | "release" | "close" | "snapshot" | "onSettled" | "onExit">;
  board: { get(): Promise<Board>; apply(op: BoardOp, baseRev?: number): Promise<Board> };
  laments: { get(): Promise<{ laments: Lament[] }>; apply(op: { type: "fix"; id: string; chat: { path: string; cwd: string }; branch?: string }): Promise<unknown> };
  settings: { get(): Promise<Settings> };
  cardImages: { save(card: string, image: { mimeType: string; data: string }): Promise<string> };
  /** The git worktree to work in for a card or lament (null: the project is not in a git repository). */
  worktree(project: string, task: { id: string; title: string }): Promise<CardWorktree | null>;
  /** pi, git and gh need the login shell's environment. */
  shellEnv: Promise<void>;
}

/** What a started chat does once pi is ready, in order: join the card or lament, switch model, send the prompt, name the chat. */
interface Setup {
  cwd: string;
  name: string;
  prompt: string;
  model?: TaskModel;
  /** Put the chat on this card, labelled with its name. */
  card?: string;
  /** Record the chat on this lament, with the branch it works on. */
  lament?: { id: string; branch?: string };
  /** Close the chat once its run ends well, unless someone is looking at it; a failed run stays open, marked. */
  closeWhenDone?: boolean;
}

export class ChatTasks {
  /** Chats whose first run is going: the lease keeps them alive, and what to do when it settles. */
  private readonly running = new Map<string, { hold: string; closeWhenDone: boolean }>();

  constructor(private readonly deps: ChatTasksDeps) {
    deps.host.onSettled((handle, outcome) => this.settled(handle, outcome));
    deps.host.onExit((handle) => void this.running.delete(handle));
  }

  /** Start the chat for a task and return it once its prompt is sent. A client may adopt it (attach) from then on. */
  async start(client: ClientPresence, target: TaskTarget): Promise<TaskStarted> {
    await this.deps.shellEnv;
    const notices: TaskNotice[] = [];
    if (target.kind === "discuss") {
      // Only a chat to write in; the card's details go with its first message (send).
      const card = await this.card(target.card);
      const { handle } = await this.deps.host.open({ cwd: card.cwd }, { client });
      return this.started(handle, notices);
    }
    const setup = await this.plan(target, notices);
    return this.run(setup, notices);
  }

  /**
   * Add a card from one description and what was attached, at the bottom of `column`: titled with the description's
   * start until a quick chat in the background (the triage model, Settings > Models) names, tags and briefly investigates it.
   * Returns once the card is on the board; its triage starts without being waited for.
   */
  async addCard(cwd: string, column: Card["column"], description: string, attachments: NewCardAttachment[] = []): Promise<{ id: string }> {
    const text = String(description ?? "").trim();
    if (!text && !attachments.length) throw new HostError("bad_request", "a card needs a description or an attachment");
    const id = freshId(await this.deps.board.get());
    await this.deps.board.apply({ type: "add", id, title: draftTitle(text) || "See the attachments", notes: text, cwd, column, before: null });
    if (attachments.length) {
      try {
        const paths: string[] = [];
        // One at a time: when one fails, none is still being written as the card is removed.
        for (const a of attachments) paths.push(a.kind === "image" ? await this.deps.cardImages.save(id, { mimeType: a.mimeType, data: a.data }) : a.path);
        await this.deps.board.apply({ type: "edit", id, notes: cardNotes(text, paths) });
      } catch (error) {
        await this.deps.board.apply({ type: "remove", id }).catch(() => undefined);
        throw new Error(`Could not attach that to the card: ${(error as Error).message}`);
      }
    }
    void this.triage(id).catch((error: Error) => log.warn("tasks", `could not start the triage of card ${id}: ${error.message}`));
    return { id };
  }

  /** `chat.send` for what a client cannot compose itself: the card's details go before the message, and the chat joins the card. */
  async send(handle: string, text: string, mode: "send" | "followUp", cardId?: string): Promise<{ accepted: boolean; error?: string }> {
    const isCommand = text.startsWith("/");
    // A command is not a message about the card: the card waits for the next one.
    const card = cardId && !isCommand ? await this.card(cardId) : undefined;
    const message = [card && cardBlock(card), text].filter(Boolean).join("\n\n");
    const cmd: RpcCommand = { type: "prompt", message };
    if (this.deps.host.stateOf(handle)?.running && !isCommand) cmd.streamingBehavior = mode === "followUp" ? "followUp" : "steer";
    const response = await this.deps.host.command(handle, cmd);
    if (!response.success) return { accepted: false, error: response.error };
    if (card) await this.attach(handle, card.id).catch((error: Error) => log.warn("tasks", `could not put the chat on card ${card.id}: ${error.message}`));
    return { accepted: true };
  }

  private triage(id: string): Promise<TaskStarted> {
    return this.start({ clientId: "host", actor: "desktop" }, { kind: "triage", card: id });
  }

  private async card(id: string): Promise<Card> {
    const card = (await this.deps.board.get()).cards.find((other) => other.id === id);
    if (!card) throw new HostError("not_found", `no card ${String(id)}`);
    return card;
  }

  /** What each kind of task starts: where, its name and prompt, and what it joins. */
  private async plan(target: Exclude<TaskTarget, { kind: "discuss" }>, notices: TaskNotice[]): Promise<Setup> {
    const note = (text: string, level: TaskNotice["level"] = "info") => notices.push({ level, text });
    switch (target.kind) {
      case "triage": {
        const [card, board, settings] = await Promise.all([this.card(target.card), this.deps.board.get(), this.deps.settings.get()]);
        const prompt = triagePrompt(card, boardTags(board, card.cwd));
        return { cwd: card.cwd, card: card.id, name: triageName(card), prompt, model: taskModel(settings, "triage"), closeWhenDone: true };
      }
      case "investigate": {
        const card = await this.card(target.card);
        note(`Investigating “${card.title}” in a new chat`);
        return { cwd: card.cwd, card: card.id, name: `Investigate: ${card.title}`, prompt: investigatePrompt(card) };
      }
      case "resolve": {
        // Resolve chats work in a git worktree of the project (made on first use, reused by later Resolves of the card).
        const card = await this.card(target.card);
        const worktree = await this.worktree(card.cwd, card, `Could not make a git worktree for “${card.title}”`);
        if (!worktree) note(`Resolving “${card.title}” in a new chat, in the project folder: it is not in a git repository`);
        else if (worktree.dirty) note(`Resolving “${card.title}” on branch ${worktree.branch}. Your checkout's uncommitted changes are not in its worktree.`, "warning");
        else note(`Resolving “${card.title}” on branch ${worktree.branch}`);
        return { cwd: worktree?.cwd ?? card.cwd, card: card.id, name: `Resolve: ${card.title}`, prompt: resolvePrompt(card, worktree) };
      }
      case "qa": {
        // QA checks the change where Resolve left it: the card's worktree when a chat on the card worked in one, else
        // the project folder (a new worktree, made from HEAD, would not have the change).
        const card = await this.card(target.card);
        const worktree = hasWorktree(card) ? await this.worktree(card.cwd, card, `Could not open the git worktree of “${card.title}”`) : null;
        note(worktree ? `Checking “${card.title}” on branch ${worktree.branch}` : `Checking “${card.title}” in a new chat`);
        return { cwd: worktree?.cwd ?? card.cwd, card: card.id, name: `QA: ${card.title}`, prompt: qaPrompt(card, worktree) };
      }
      case "fix": {
        // Fix works in the lament's git worktree, on a branch of its own (reused by later Fixes). It does not resolve the lament.
        const lament = (await this.deps.laments.get()).laments.find((other) => other.id === target.lament);
        if (!lament) throw new HostError("not_found", `no lament ${String(target.lament)}`);
        const worktree = await this.worktree(lament.cwd, { id: lament.id, title: `fix ${lament.title}` }, `Could not make a git worktree to fix “${lament.title}”`);
        if (!worktree) note(`Fixing “${lament.title}” in a new chat, in the project folder: it is not in a git repository`);
        else if (worktree.dirty) note(`Fixing “${lament.title}” on branch ${worktree.branch}. Your checkout's uncommitted changes are not in its worktree.`, "warning");
        else note(`Fixing “${lament.title}” on branch ${worktree.branch}`);
        return { cwd: worktree?.cwd ?? lament.cwd, name: `Fix: ${lament.title}`, prompt: fixPrompt(lament, worktree), lament: { id: lament.id, branch: worktree?.branch } };
      }
      case "review": {
        const { cwd, repo, item } = target;
        if (typeof cwd !== "string" || !cwd.startsWith("/") || !repo?.repo || !item?.title) throw new HostError("bad_request", "a review needs a project, a repository and a pull request");
        return { cwd, name: reviewName(item), prompt: reviewPrompt(repo, item, target.login) };
      }
      default:
        throw new HostError("bad_request", `unknown task ${String((target as { kind?: unknown }).kind)}`);
    }
  }

  private async worktree(project: string, task: { id: string; title: string }, failure: string): Promise<CardWorktree | null> {
    try {
      return await this.deps.worktree(project, task);
    } catch (error) {
      throw new Error(`${failure}: ${(error as Error).message}`);
    }
  }

  /** Open the chat under a host lease, wait for pi, and do the setup in order; the lease ends when its first run settles. */
  private async run(setup: Setup, notices: TaskNotice[]): Promise<TaskStarted> {
    const { host } = this.deps;
    const hold = `task:${randomUUID()}`;
    const request: OpenSessionRequest = { cwd: setup.cwd };
    const { handle } = await host.open(request, { hold });
    try {
      // pi answers once it is ready.
      const ready = await host.command(handle, { type: "get_state" });
      if (!ready.success) throw new Error(ready.error ?? "pi did not start");
      if (setup.card) await this.attach(handle, setup.card, setup.name).catch((error: Error) => notices.push({ level: "warning", text: error.message }));
      if (setup.lament) await this.linkLament(handle, setup.lament, notices);
      if (setup.model) await this.useModel(handle, setup.model, notices);
      // Registered before the prompt: the run's end is what ends the lease.
      this.running.set(handle, { hold, closeWhenDone: setup.closeWhenDone === true });
      const sent = await host.command(handle, { type: "prompt", message: setup.prompt });
      if (!sent.success) throw new Error(sent.error ?? "the prompt was not accepted");
      await host.command(handle, { type: "set_session_name", name: setup.name });
    } catch (error) {
      // Left open and unhandled by anyone: the client finds it (and its error) in the sidebar.
      this.running.delete(handle);
      host.release(handle, hold);
      notices.push({ level: "warning", text: `Could not set up “${setup.name}”: ${(error as Error).message}` });
    }
    return this.started(handle, notices);
  }

  private started(handle: string, notices: TaskNotice[]): TaskStarted {
    return { handle, snapshot: this.deps.host.snapshot(handle, { turns: Number.MAX_SAFE_INTEGER }) ?? null, notices };
  }

  /** The first run ended: the chat is no longer held. A good one closes itself when nobody is looking; a failed one stays, marked. */
  private settled(handle: string, outcome: RunOutcome): void {
    const task = this.running.get(handle);
    if (!task) return;
    this.running.delete(handle);
    const { host } = this.deps;
    if (task.closeWhenDone && outcome === "done" && !host.presence(handle).some((client) => client.viewing)) void host.close(handle, "host");
    else host.release(handle, task.hold);
  }

  /** A chat's session file and cwd, which a card or lament keeps to open it. */
  private async sessionFile(handle: string): Promise<{ path: string; cwd: string }> {
    try {
      return await this.deps.host.identify(handle);
    } catch {
      throw new Error("This chat has no session file, so pi-gna cannot link to it");
    }
  }

  /** Put a chat on a card, by its session file. */
  private async attach(handle: string, card: string, label?: string): Promise<void> {
    const chat = await this.sessionFile(handle);
    await this.deps.board.apply({ type: "attach", id: card, chat: { ...chat, ...(label ? { label: label.slice(0, LIMITS.title) } : {}) } });
  }

  private async linkLament(handle: string, lament: { id: string; branch?: string }, notices: TaskNotice[]): Promise<void> {
    try {
      const chat = await this.sessionFile(handle);
      await this.deps.laments.apply({ type: "fix", id: lament.id, chat, ...(lament.branch ? { branch: lament.branch } : {}) });
    } catch (error) {
      notices.push({ level: "warning", text: (error as Error).message });
    }
  }

  /** Switch a new chat to a task's model. For this chat only: pi keeps your default model and thinking level. */
  private async useModel(handle: string, want: TaskModel, notices: TaskNotice[]): Promise<void> {
    const { host } = this.deps;
    const models = (await host.command(handle, { type: "get_available_models" })) as RpcResponse<{ models: Model[] }>;
    const model = pickModel(models.data?.models ?? [], want, host.stateOf(handle)?.model?.provider);
    if (!model) {
      notices.push({ level: "warning", text: `${want.provider ? `${want.provider}/` : ""}${want.id} is not available, so this chat runs on your default model` });
      return;
    }
    await host.command(handle, { type: "set_model", provider: model.provider, modelId: model.id });
    await host.command(handle, { type: "set_thinking_level", level: want.thinking });
  }
}
