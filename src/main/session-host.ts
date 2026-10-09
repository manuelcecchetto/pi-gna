// Maps renderer handles to pi processes and forwards their records to the window.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { basename, isAbsolute } from "node:path";
import { type AtpSession, isPlanPath } from "../shared/atp";
import { projectOf } from "../shared/board";
import { jsonBytes } from "../shared/chat-page";
import { type Actor, actorOf, type AttentionSummary, type ChatSnapshot, type ClientPresence, type DialogOutcome, type GlobalEvent, type HostCtx, HostError, type HostEvent, isAllowedRpc, type QueueEdit } from "../shared/host-api";
import type { OpenSessionRequest, OpenSessionResult } from "../shared/ipc";
import { DIALOG_METHODS, type ExtensionUiResponse, type RpcCommand, type RpcOutput, RpcResponse, RpcSessionState, type SessionEntry } from "../shared/protocol";
import { type Feature, yoloOption } from "../shared/settings";
import { attention, createSession, hydrate, isDisposable, isListed, type Item, leanRecord, reduceHostEvent, runOutcome, type RunOutcome, type SessionState } from "../shared/session-state";
import { applyQueueOp, type Queues } from "../shared/queue";
import { turnOutline } from "../shared/turn-outline";
import { atpSkills, librarianPath } from "./atp";
import type { AgentBridge } from "./bridge";
import { COALESCE_MS, coalesce, isDelta } from "./coalesce";
import { KeyedMutex } from "./command-layer";
import { log } from "./log";
import { evictPayloads, PayloadFiles, restorePayloads } from "./payloads";
import { type PiExit, PiProcess, type PiProcessHandlers } from "./pi-process";
import { piInputs, projectTrust } from "./pi-settings";
import { onDisk } from "./resources";
import { MIN_INLINE_CHARS } from "./remote-images";
import { readActiveBranch } from "./session-file";

/** How long an approval card waits for the user before it counts as a refusal. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Dialogs answered lately are remembered per chat, so a late second answer reads "already answered", not "unknown". */
const RESOLVED_KEPT = 200;
/** Commands that read or change pi's queues or run state: serialized with `interrupt` and `editQueue`. */
const ORDERED = new Set<RpcCommand["type"]>(["prompt", "steer", "follow_up", "clear_queue", "abort"]);
/** The desktop window: trusted, the default caller. */
const DESKTOP: HostCtx = { caller: "desktop", clientId: "desktop", bootId: "" };
const HANDLE = /^[a-z0-9]{6,32}$/;
/** A chat nobody needs stops its pi after this long idle (`stopIdle`); it opens again from its session file. */
const IDLE_STOP_MS = 30 * 60_000;
/** At most this many idle chats keep their pi: past that, the ones idle longest stop first. */
const IDLE_KEPT = 8;
/** How often idle chats are looked for. */
const IDLE_CHECK_MS = 60_000;
/** A spare pi starts this long after a chat a client opened is ready, for the next New chat in its folder. */
const SPARE_DELAY_MS = 2_000;
/** A spare nobody adopts stops after this long. */
const SPARE_KEPT_MS = 10 * 60_000;
/** Tools that would compete with the integrated browser (Stagehand's). Override with PIGNA_EXCLUDE_TOOLS. */
const EXCLUDED_TOOLS = process.env.PIGNA_EXCLUDE_TOOLS ?? "run,snapshot,screenshot";

/** What is on when a chat starts: the Settings page's features, and Computer Use. */
export type SessionFeatures = Record<Feature | "computer" | "visuals", boolean>;
const NONE: SessionFeatures = { kanban: false, laments: false, github: false, atp: false, computer: false, visuals: false };

/** Events for one chat, as they go to the event hub (which stamps them with a `seq`). */
export interface ChatBatch {
  handle: string;
  events: HostEvent[];
}

/** A chat the host keeps alive: its pi process, authoritative state, and who is attached. */
interface Live {
  pi: PiProcess;
  cwd: string;
  state: SessionState;
  /** `seq` of the last event `state` reflects. */
  seq: number;
  /**
   * Leases of clients (a window, a phone); `viewing` is the foreground chat of that client, `shown` a chat it has on
   * screen whether or not it is focused (the window's active chat, also behind a page).
   */
  clients: Map<string, { actor: ClientPresence["actor"]; viewing: boolean; shown: boolean }>;
  /** Leases of host-side owners (an ATP runner, a background task): the chat has no viewer but must not be disposed. */
  holds: Set<string>;
  settled?: { outcome: RunOutcome; at: number };
  /** Dialogs waiting for an answer (pi's and main's own), with the timer that mirrors pi's timeout. */
  dialogs: Map<string, ReturnType<typeof setTimeout> | undefined>;
  resolved: Set<string>;
  /**
   * Set while the session file is read beside pi's boot (see `open`): what pi says meanwhile waits here and applies
   * after the history, in order, as it did when the file was read first.
   */
  loading?: { entries: Promise<SessionEntry[]>; held: HostEvent[]; exit?: () => void };
  /** Streaming deltas waiting for the next frame (`coalesce.ts`): not in `state` or `seq` yet. */
  waiting: HostEvent[];
  flush?: ReturnType<typeof setTimeout>;
  /** When something last happened in the chat (an event, a client showing it or leaving it): idle chats stop by it. */
  active: number;
  /** The chat's session files, where the payloads dropped from `state` are read back from for a page. */
  payloads: PayloadFiles;
  /** Items before this one had their old payloads dropped (`evictPayloads`). */
  evictedTo: number;
}

/**
 * A pi started ahead of the next New chat (`spawnSpare`), with what it was started with: a chat adopts it only when it
 * would start its own pi the same way.
 */
interface Spare {
  /** The handle its bridge token is registered under until a chat adopts it. */
  handle: string;
  tag: string;
  cwd: string;
  trust: boolean | undefined;
  /** The features it has, as JSON. */
  features: string;
  /** pi's files as they were when it started (`piInputs`). */
  inputs: string;
  pi: PiProcess;
  relay: Relay;
  since: number;
  timer: ReturnType<typeof setTimeout>;
}

/** A spare's handlers: what its pi says waits here until a chat adopts it (`connect`), then goes to that chat. */
class Relay implements PiProcessHandlers {
  private readonly held: Parameters<PiProcessHandlers["onRecords"]>[0][] = [];
  private target?: PiProcessHandlers;

  /** `exited`: pi ended before any chat adopted it. */
  constructor(private readonly exited: (exit: PiExit) => void) {}

  onRecords(records: Parameters<PiProcessHandlers["onRecords"]>[0]): void {
    if (this.target) this.target.onRecords(records);
    else this.held.push(records);
  }

  onExit(exit: PiExit): void {
    (this.target ?? { onExit: this.exited }).onExit(exit);
  }

  connect(target: PiProcessHandlers): void {
    this.target = target;
    for (const records of this.held.splice(0)) target.onRecords(records);
  }
}

/** Why a spare is not the pi a New chat in its folder would start now; undefined when it is. */
function stale(spare: Spare, trust: boolean | undefined, features: string, inputs: string): string | undefined {
  if (spare.features !== features) return "features changed";
  if (spare.trust !== trust) return "trust changed";
  if (spare.inputs !== inputs) return "pi's settings or context files changed";
  return undefined;
}

/** The machine is busy: the 1-minute load average is at its cores. */
const busy = () => loadavg()[0]! >= availableParallelism();

export interface ChatPage {
  /** Turns (user prompts) wanted, counting back from `beforeTurn` (default: the end). */
  turns: number;
  beforeTurn?: number;
  /** The page ends this many items into turn `beforeTurn` (the start of a page cut inside that turn: `turns.offset`). */
  offset?: number;
  /**
   * At most about this much JSON: fewer turns when they are big (tool output, screenshots), and of a newest turn too
   * big alone (a run of hours) its last items, but always one.
   */
  bytes?: number;
  /** Also a line for each turn whose prompt is before the page (the desktop's turn rail). */
  outline?: boolean;
  /** The page goes to a phone, which gets big images as a URL (`RemoteImages`): `bytes` counts them so. */
  imagesByUrl?: boolean;
}

export class SessionHost {
  private readonly live = new Map<string, Live>();
  /** Session file -> the one handle whose pi has it open (two pis on one file are unsafe). */
  private readonly byFile = new Map<string, string>();
  private readonly mutex = new KeyedMutex();
  private readonly summaries = new Map<string, AttentionSummary>();
  private publishGlobal: (event: GlobalEvent) => void = () => {};
  /** Choices main asked of the user (requestChoice). Answered from the window only; pi never sees them. */
  private readonly choices = new Map<string, { handle: string; resolve: (value: string | undefined) => void }>();
  private readonly endListeners = new Set<(handle: string) => void>();
  private readonly exitListeners = new Set<(handle: string) => void>();
  private readonly presenceListeners = new Set<(handle: string) => void>();
  private readonly settleListeners = new Set<(handle: string, outcome: RunOutcome) => void>();
  private readonly working = new Set<string>();
  private readonly runningListeners = new Set<() => void>();
  /** The browser_*, set_theme, threads_*, kanban_* and lament tools and the chat titler, which reach pi-gna through the bridge. */
  private readonly extensions = {
    browser: onDisk("resources", "browser-extension.ts"),
    theme: onDisk("resources", "theme-extension.ts"),
    kanban: onDisk("resources", "kanban-extension.ts"),
    laments: onDisk("resources", "lament-extension.ts"),
    threads: onDisk("resources", "threads-extension.ts"),
    title: onDisk("resources", "title-extension.ts"),
  };
  private readonly idleCheck: ReturnType<typeof setInterval>;
  /** At most one pi waiting for the next New chat (`spawnSpare`). */
  private spare?: Spare;
  private spareTimer?: ReturnType<typeof setTimeout>;
  /** Bumped by each spare spawn and retire: a spawn that waited on the disk meanwhile gives up. */
  private spareTurn = 0;
  private closing = false;
  /** Tells the model its replies render as Markdown in pi-gna (pi-gna sessions only, not the terminal UI). */
  private readonly prompt = onDisk("resources", "pigna-prompt.md");
  /** Skills pi-gna bundles: pr-review, which the GitHub page's Review starts a chat with. */
  private readonly skills = { prReview: onDisk("resources", "skills", "pr-review") };

  constructor(
    /** Delivers a batch to the hub; returns the `seq` of its last event (0 if the sink does not number them). */
    private readonly emit: (batch: ChatBatch) => number | void,
    private readonly bridge: AgentBridge,
    /** Where ATP chats keep their session files, apart from pi's, so they stay out of the sidebar. */
    private readonly atpSessions: string,
    /** Read at spawn: a feature's tools exist only in chats opened while it is on. */
    private readonly features: () => Promise<SessionFeatures> = async () => NONE,
    /** The yolo setting, read at each approval: on, an approval is allowed without a card (`autoApprove`). */
    private readonly yolo: () => boolean = () => false,
  ) {
    this.idleCheck = setInterval(() => this.stopIdle(), IDLE_CHECK_MS);
    this.idleCheck.unref?.();
  }

  /** Yolo: answer an approval from pi as the user would allow it, instead of showing its card. A confirm is a yes, a
   * select takes its allowing option (yoloOption); a select without one, and inputs, still go to the user. */
  private autoApprove(pi: PiProcess, tag: string, record: RpcOutput): boolean {
    if (record.type !== "extension_ui_request") return false;
    let response: ExtensionUiResponse;
    if (record.method === "confirm") response = { type: "extension_ui_response", id: record.id, confirmed: true };
    else if (record.method === "select") {
      const value = yoloOption(record.options);
      if (value === undefined) return false;
      response = { type: "extension_ui_response", id: record.id, value };
    } else return false;
    log.info(tag, `yolo approved "${record.title}"`);
    pi.respondUi(response);
    return true;
  }

  /** `trust`: whether pi may load the project's own resources, when pi cannot tell from the cwd itself. */
  /** @internal exposed for tests */
  piArgs(handle: string, trust: boolean | undefined, atp: AtpSession | undefined, features: SessionFeatures): { args: string[]; env: Record<string, string> } {
    const args = ["-e", this.extensions.browser, "-e", this.extensions.theme, "-e", this.extensions.threads, "-e", this.extensions.title, "--append-system-prompt", this.prompt];
    if (features.visuals) args.push("-e", onDisk("resources", "visual-extension.ts"));
    if (features.kanban) args.push("-e", this.extensions.kanban);
    if (features.laments) args.push("-e", this.extensions.laments);
    if (features.github) args.push("--skill", this.skills.prReview);
    if (features.computer) args.push("-e", onDisk("resources", "computer-extension.ts"));
    if (EXCLUDED_TOOLS) args.push("--exclude-tools", EXCLUDED_TOOLS);
    if (trust !== undefined) args.push(trust ? "--approve" : "--no-approve");
    if (atp) args.push(...this.atpArgs(atp));
    return { args, env: { PIGNA_BRIDGE: this.bridge.url, PIGNA_TOKEN: this.bridge.register(handle) } };
  }

  /** An ATP chat: its own session folder, the ATP skills of its role, and its role's prompt (src/shared/atp.ts). */
  private atpArgs(atp: AtpSession): string[] {
    const args = ["--session-dir", this.atpSessions, ...atpSkills(atp.role).flatMap((path) => ["--skill", path])];
    args.push("--append-system-prompt", onDisk("resources", "atp", `${atp.role}.md`));
    if (atp.role === "orchestrator") args.push("-e", onDisk("resources", "atp-extension.ts"));
    const plan = atp.plan ? `This chat's ATP plan: ${atp.plan}` : "This chat has no ATP plan yet: the user is about to create one.";
    args.push("--append-system-prompt", `${plan}\nThe librarian CLI: python3 '${librarianPath()}' <command> --plan-path <absolute plan path> ...`);
    return args;
  }

  get size(): number {
    return this.live.size;
  }

  /** Where `chat.opened`, `chat.closed` and attention summaries go (the global topic). */
  onGlobal(publish: (event: GlobalEvent) => void): void {
    this.publishGlobal = publish;
  }

  /** The handles are the host's: 12 base-36 characters (the HANDLE format). */
  private newHandle(): string {
    let handle: string;
    do handle = randomUUID().replaceAll("-", "").slice(0, 12);
    while (this.live.has(handle) || this.spare?.handle === handle);
    return handle;
  }

  /**
   * Open a chat, or join the live one when `sessionPath` is already open (the existing handle comes back; the file is
   * not read again, the live state is newer). With `page` the result carries that snapshot of the chat, taken once its
   * history is in and before what pi said meanwhile: those events follow it. Without, the caller reads the chat
   * through `chat.attach` or `chat.snapshot`.
   * `request.handle` is honored only while the desktop still picks its own; the host issues one otherwise.
   * The caller gets a lease: `client` (attach/detach) or `hold` (released by `release`).
   */
  async open(request: OpenSessionRequest, lease?: { client?: ClientPresence; hold?: string }, page?: ChatPage): Promise<OpenSessionResult> {
    const { cwd, sessionPath, atp } = request;
    const existing = sessionPath ? this.byFile.get(sessionPath) : undefined;
    if (existing && this.live.has(existing)) return this.join(existing, lease, page);
    if (request.handle !== undefined && (!HANDLE.test(request.handle) || this.live.has(request.handle))) throw new Error("invalid session handle");
    const handle = request.handle ?? this.newHandle();
    if (atp && ((atp.role !== "worker" && atp.role !== "orchestrator") || (atp.plan !== undefined && !isPlanPath(atp.plan)))) throw new Error("invalid ATP session");
    if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new Error(`not a directory: ${cwd}`);
    if (sessionPath !== undefined && (!isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl"))) throw new Error("invalid session path");

    const started = Date.now();
    const tag = `pi·${handle.slice(0, 4)}`;
    const trust = await this.trustOf(cwd);

    const features = await this.features().catch(() => NONE);
    if (atp && !features.atp) throw new Error("ATP is turned off in pi-gna's Settings");
    // The bridge starts beside the window, not before it; a pi learns its URL at spawn.
    await this.bridge.start();
    // A second open of the same file may have started its pi while this one resolved trust and features.
    const raced = sessionPath ? this.byFile.get(sessionPath) : undefined;
    if (raced && this.live.has(raced)) return this.join(raced, lease, page);
    // pi boots (seconds) while the session file is read below; a failed read stops it without a trace.
    let abandoned = false;
    const handlers: PiProcessHandlers = {
      onRecords: (records) => {
        if (abandoned) return;
        const shown = this.yolo() ? records.filter((record) => !this.autoApprove(pi, tag, record)) : records;
        this.push(handle, shown.map((record) => ({ kind: "rpc", record: leanRecord(record) })));
        if (records.some((record) => record.type === "agent_start")) this.started(handle);
        if (records.some((record) => record.type === "agent_end" && !record.willRetry)) this.ended(handle);
      },
      onExit: (exit) => {
        if (abandoned) return;
        const loading = this.live.get(handle)?.loading;
        if (loading) {
          loading.exit = () => this.exited(handle, exit);
          return;
        }
        this.exited(handle, exit);
      },
    };
    // A New chat takes the spare pi, booted already, when it was started as this chat's would be.
    const spare = sessionPath || atp ? undefined : await this.takeSpare(cwd, trust, features);
    if (spare) {
      this.bridge.rename(spare.handle, handle);
      log.info(spare.tag, `adopted by ${tag}, warm for ${Math.round((Date.now() - spare.since) / 1000)} s`);
    }
    const pi = spare?.pi ?? new PiProcess({ cwd, sessionPath, tag, ...this.piArgs(handle, trust, atp, features) }, handlers);
    const entries = sessionPath ? readActiveBranch(sessionPath) : Promise.resolve([]);
    const chat: Live = {
      pi,
      cwd,
      state: createSession(handle, cwd, sessionPath, atp),
      seq: 0,
      clients: new Map(),
      holds: new Set(),
      dialogs: new Map(),
      resolved: new Set(),
      loading: { entries, held: [] },
      waiting: [],
      active: Date.now(),
      payloads: new PayloadFiles(),
      evictedTo: 0,
    };
    chat.payloads.use(sessionPath);
    this.live.set(handle, chat);
    if (sessionPath) this.byFile.set(sessionPath, handle);
    // What the spare said while it waited follows, held with the rest until the history is in.
    spare?.relay.connect(handlers);
    void pi.send<RpcSessionState>({ type: "get_state" }).then((response) => {
      if (abandoned || !response.success || !response.data) return;
      log.info(tag, `ready in ${Date.now() - started} ms  (${response.data.model?.provider}/${response.data.model?.id}, ${response.data.thinkingLevel})${spare ? "  spare" : ""}`);
      this.push(handle, [{ kind: "ready", state: response.data }]);
      // The next New chat in this folder will want a pi too: start one while nobody waits on it.
      if (lease?.client && !atp) this.planSpare(cwd);
    });

    const reading = Date.now();
    let history: SessionEntry[];
    try {
      history = await entries;
    } catch (error) {
      abandoned = true;
      this.live.delete(handle);
      if (sessionPath && this.byFile.get(sessionPath) === handle) this.byFile.delete(sessionPath);
      this.bridge.unregister(handle);
      void pi.close();
      throw error;
    }
    if (sessionPath) log.info(tag, `loaded ${history.length} entries in ${Date.now() - reading} ms`);
    chat.state = hydrate(chat.state, history);
    const { held, exit } = chat.loading!;
    chat.loading = undefined;
    this.lease(handle, lease);
    this.publishGlobal({ kind: "chat.opened", handle, cwd, sessionPath });
    this.touch(handle);
    // Before the held events and the exit: a pi that could not start still leaves the history to read. Taken from
    // the whole history, before the old payloads leave it.
    const snapshot = page && this.snapshot(handle, page);
    this.evict(chat);
    if (held.length) this.push(handle, held);
    exit?.();
    return { handle, ...(snapshot && { snapshot: await snapshot }) };
  }

  /** pi looks up your trust in a project by the cwd's folders, and a card's worktree lives outside the project. */
  private async trustOf(cwd: string): Promise<boolean | undefined> {
    const project = projectOf(cwd);
    return project === cwd ? undefined : await projectTrust(project);
  }

  /** Join the chat that has the file open, once its history is in; the file is not read again. */
  private async join(handle: string, lease?: { client?: ClientPresence; hold?: string }, page?: ChatPage): Promise<OpenSessionResult> {
    await this.live.get(handle)?.loading?.entries;
    this.lease(handle, lease);
    const snapshot = page && (await this.snapshot(handle, page));
    return { handle, reused: true, ...(snapshot && { snapshot }) };
  }

  /** pi's process ended: settle what waited on it and forget the chat. */
  private exited(handle: string, exit: PiExit): void {
    this.settleChoices(handle);
    this.settleDialogs(handle, "exit");
    this.ended(handle);
    this.bridge.unregister(handle);
    for (const listener of this.exitListeners) listener(handle);
    this.push(handle, [{ kind: "exit", ...exit }]);
    const gone = this.live.get(handle);
    if (gone?.state.sessionPath && this.byFile.get(gone.state.sessionPath) === handle) this.byFile.delete(gone.state.sessionPath);
    this.live.delete(handle);
    this.summaries.delete(handle);
    this.publishGlobal({ kind: "chat.closed", handle });
    this.publishGlobal({ kind: "attention", chats: [], removed: [handle] });
  }

  /**
   * Send a command to pi. A remote caller gets the RPC allowlist (`bash`, `new_session` and the rest are refused);
   * the desktop is trusted. Commands that touch the queues run in order with `interrupt` and `editQueue`.
   */
  command(handle: string, command: RpcCommand, ctx: HostCtx = DESKTOP): Promise<RpcResponse> {
    if (ctx.caller !== "desktop" && !isAllowedRpc(command)) return Promise.reject(new HostError("scope_denied", `command not allowed remotely: ${String(command.type)}`));
    return ORDERED.has(command.type) ? this.mutex.run(handle, () => this.send(handle, command)) : this.send(handle, command);
  }

  private send(handle: string, command: RpcCommand): Promise<RpcResponse> {
    const chat = this.live.get(handle);
    if (!chat) return Promise.resolve({ type: "response", command: command.type, success: false, error: "session is not running" });
    // A chat you prompted from pi-gna stays alive when everyone navigates away, until it is idle a while (`stopIdle`).
    if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") chat.state = { ...chat.state, prompted: true };
    const sent = chat.pi.send(command);
    // The host's snapshot is what a client joining later (phone, another window) shows: keep its model and thinking level current.
    if (command.type === "set_model" || command.type === "set_thinking_level") void sent.then((response) => response.success && this.refreshState(handle));
    return sent;
  }

  private refreshState(handle: string): void {
    const chat = this.live.get(handle);
    if (!chat) return;
    void chat.pi.send<RpcSessionState>({ type: "get_state" }).then((response) => {
      if (response.success && response.data && this.live.get(handle) === chat) this.push(handle, [{ kind: "ready", state: response.data }]);
    });
  }

  /** Esc: take the queued messages back (returned to the caller), then abort the run or manual compaction. Atomic per chat. */
  interrupt(handle: string): Promise<string[]> {
    return this.mutex.run(handle, async () => {
      const state = this.live.get(handle)?.state;
      if (!state || (!state.running && !state.compacting)) return [];
      const cleared = await this.send(handle, { type: "clear_queue" });
      const data = cleared.data as Queues | undefined;
      const restored = [...(data?.steering ?? []), ...(data?.followUp ?? [])];
      await this.send(handle, { type: "abort" });
      return restored;
    });
  }

  /**
   * Edit pi's queues (trash, steer now, defer, take out to edit). RPC can only clear both queues and append, so this
   * clears, applies the op and re-queues the rest in order, without another command in between. Images on
   * re-queued messages are lost.
   */
  editQueue(handle: string, op: QueueEdit): Promise<boolean> {
    return this.mutex.run(handle, async () => {
      if (!this.live.get(handle)?.state.running) return false;
      const cleared = await this.send(handle, { type: "clear_queue" });
      if (!cleared.data) return false;
      const { queues, found } = applyQueueOp(cleared.data as Queues, op);
      for (const message of queues.steering) await this.send(handle, { type: "steer", message });
      for (const message of queues.followUp) await this.send(handle, { type: "follow_up", message });
      return found;
    });
  }

  // ── State, snapshots, attention ──────────────────────────────────────────────

  /**
   * Reduce events into the chat's authoritative state (host clock), then publish them and its attention. Streaming
   * deltas wait up to a frame and go out merged; any other event sends the waiting ones first, so order is kept. A
   * snapshot taken meanwhile does not hold them, and they follow it (higher `seq`).
   */
  private push(handle: string, events: HostEvent[]): void {
    const chat = this.live.get(handle);
    if (!chat) {
      this.emit({ handle, events });
      return;
    }
    if (chat.loading) {
      chat.loading.held.push(...events);
      return;
    }
    if (events.length && events.every(isDelta)) {
      chat.waiting.push(...events);
      chat.flush ??= setTimeout(() => this.live.get(handle) === chat && this.push(handle, []), COALESCE_MS);
      return;
    }
    clearTimeout(chat.flush);
    chat.flush = undefined;
    events = coalesce(chat.waiting.length ? [...chat.waiting.splice(0), ...events] : events);
    if (!events.length) return;
    const now = Date.now();
    chat.active = now;
    let state = chat.state;
    const settledNow: RunOutcome[] = [];
    for (const event of events) {
      this.trackDialog(handle, chat, event);
      state = reduceHostEvent(state, event, now);
      if (event.kind === "rpc" && event.record.type === "agent_settled") {
        const outcome = runOutcome(state.items);
        chat.settled = { outcome, at: now };
        if (![...chat.clients.values()].some((client) => client.viewing)) state = { ...state, unread: outcome };
        settledNow.push(outcome);
      }
    }
    chat.state = state;
    // Sessions that pi switches to another file (/new, /resume, forks) move their dedupe entry.
    if (state.sessionPath && this.byFile.get(state.sessionPath) !== handle) {
      for (const [file, owner] of this.byFile) if (owner === handle) this.byFile.delete(file);
      this.byFile.set(state.sessionPath, handle);
      chat.payloads.use(state.sessionPath);
    }
    // A run that settled moved a turn out of the ones kept whole: what it wrote is in the file now.
    if (settledNow.length) this.evict(chat);
    chat.seq = this.emit({ handle, events }) || chat.seq;
    this.touch(handle);
    for (const outcome of settledNow) for (const listener of this.settleListeners) listener(handle, outcome);
  }

  /**
   * The chat's state paged by user turns: the last `turns` before `beforeTurn` (default the end), or before `offset`
   * items into it. `seq` is the last event the state reflects; a client applies only events after it. Earlier pages
   * carry just their items. A page cut inside its first turn says so in `turns.offset`: that many items of turn
   * `turns.from` come before it. `outline` adds a line for each turn whose prompt is before the page.
   */
  async snapshot(handle: string, page: ChatPage): Promise<(ChatSnapshot & { seq: number }) | undefined> {
    const chat = this.live.get(handle);
    // The page is cut now, in this turn; what it reads back from the file does not change which events it reflects.
    const cut = chat && this.page(chat, page);
    if (!cut) return undefined;
    const items = await restorePayloads(cut.state.items as Item[], chat.payloads);
    return items === cut.state.items ? cut : { ...cut, state: { ...cut.state, items } };
  }

  private page(chat: Live, page: ChatPage): ChatSnapshot & { seq: number } {
    const { items } = chat.state;
    const starts = items.flatMap((item, index) => (item.kind === "user" && !item.steer ? [index] : []));
    const total = starts.length;
    // A turn's items run from its prompt (the first turn's from the start) to the next prompt.
    const head = (turn: number) => (turn === 0 ? 0 : starts[turn]!);
    const tail = (turn: number) => (turn + 1 >= total ? items.length : starts[turn + 1]!);
    const cursor = Math.min(page.beforeTurn ?? total, total);
    const inside = cursor < total ? Math.min(Math.max(0, page.offset ?? 0), tail(cursor) - head(cursor)) : 0;
    const end = inside > 0 ? head(cursor) + inside : cursor >= total ? items.length : starts[cursor]!;
    const newest = inside > 0 ? cursor : cursor - 1;
    let from = Math.max(0, newest + 1 - Math.max(1, page.turns));
    let start = head(from);
    if (page.bytes !== undefined) {
      let size = 0;
      for (let turn = newest; turn >= from; turn--) {
        let index = Math.min(tail(turn), end);
        while (index > head(turn)) {
          const bytes = jsonBytes(items[index - 1], page.imagesByUrl ? MIN_INLINE_CHARS : undefined);
          // The page keeps its last item even when that alone is too big.
          if (size + bytes > page.bytes && size > 0) break;
          size += bytes;
          index--;
        }
        if (index === head(turn)) continue;
        // An older turn that does not fit stays out whole; the newest one comes from where its items stop fitting.
        [from, start] = turn === newest ? [turn, index] : [turn + 1, head(turn + 1)];
        break;
      }
      // Never cut before the first prompt: the items before it come with it.
      if (from === 0 && total > 0 && start <= starts[0]!) start = 0;
    }
    const offset = start - head(from);
    const slice = items.slice(start, end);
    const outline = page.outline ? starts.slice(0, offset > 0 ? from + 1 : from).map((index) => turnOutline(items[index] as Extract<Item, { kind: "user" }>)) : undefined;
    return { seq: chat.seq, state: { ...chat.state, items: slice }, turns: { total, from, ...(offset > 0 && { offset }) }, ...(outline && { outline }) };
  }

  /**
   * The authoritative state (tests, host-side decisions), without the payloads dropped from its older turns
   * (`evictPayloads`): clients read the chat through `snapshot`, which brings them back.
   */
  stateOf(handle: string): SessionState | undefined {
    return this.live.get(handle)?.state;
  }

  /** Drop the payloads of the turns that are no longer among the last kept whole; the session file has them. */
  private evict(chat: Live): void {
    if (!chat.payloads.paths.length) return;
    if (chat.evictedTo > chat.state.items.length) chat.evictedTo = 0;
    const { items, to } = evictPayloads(chat.state.items, chat.evictedTo);
    chat.evictedTo = to;
    if (items !== chat.state.items) chat.state = { ...chat.state, items };
  }

  private summary(handle: string, chat: Live): AttentionSummary {
    const { state } = chat;
    return {
      handle,
      cwd: chat.cwd,
      sessionPath: state.sessionPath,
      title: state.name ?? state.title ?? basename(chat.cwd),
      listed: isListed(state),
      attention: attention(state),
      running: state.running,
      dialogs: state.dialogs.length,
      settled: chat.settled,
    };
  }

  /** Publish the attention summary of a chat when it changed. */
  private touch(handle: string): void {
    const chat = this.live.get(handle);
    if (!chat) return;
    const summary = this.summary(handle, chat);
    const last = this.summaries.get(handle);
    if (last && sameSummary(last, summary)) return;
    this.summaries.set(handle, summary);
    this.publishGlobal({ kind: "attention", chats: [summary], removed: [] });
  }

  /** Attention of every live chat (a client's first paint of the sidebar marks). */
  attentionAll(): AttentionSummary[] {
    return [...this.live].flatMap(([handle, chat]) => (chat.loading ? [] : [this.summary(handle, chat)]));
  }

  // ── Leases and presence ──────────────────────────────────────────────────────

  private lease(handle: string, lease?: { client?: ClientPresence; hold?: string }): void {
    if (lease?.hold) this.live.get(handle)?.holds.add(lease.hold);
    if (lease?.client) this.attach(handle, lease.client);
  }

  /** A client opens the chat (a window, a phone): its pi keeps running while anyone is attached. */
  attach(handle: string, client: ClientPresence): void {
    const chat = this.live.get(handle);
    if (!chat) throw new Error("session is not running");
    if (!chat.clients.has(client.clientId)) chat.clients.set(client.clientId, { actor: client.actor, viewing: false, shown: false });
    this.presenceChanged(handle);
  }

  /** The client leaves; the pi stops if that was the last lease and the chat is disposable. */
  detach(handle: string, clientId: string): void {
    const chat = this.live.get(handle);
    if (!chat?.clients.delete(clientId)) return;
    this.presenceChanged(handle);
    this.disposeIfIdle(handle);
  }

  /** A client's foreground chat changed (`viewing`): being looked at clears the unread mark. */
  viewing(handle: string, clientId: string, viewing: boolean): void {
    const chat = this.live.get(handle);
    const client = chat?.clients.get(clientId);
    if (!chat || !client || client.viewing === viewing) return;
    client.viewing = viewing;
    if (viewing && chat.state.unread) {
      chat.state = { ...chat.state, unread: undefined };
      this.touch(handle);
    }
    this.presenceChanged(handle);
  }

  /** A client has the chat on screen, or no longer has (focused or not, unlike `viewing`): its pi is not stopped for being idle. */
  shown(handle: string, clientId: string, shown: boolean): void {
    const chat = this.live.get(handle);
    const client = chat?.clients.get(clientId);
    if (!chat || !client || client.shown === shown) return;
    client.shown = shown;
    chat.active = Date.now();
  }

  /** Who is attached to the chat, and which of them have it in the foreground. */
  presence(handle: string): ClientPresence[] {
    return [...(this.live.get(handle)?.clients ?? [])].map(([clientId, client]) => ({ clientId, actor: client.actor, viewing: client.viewing }));
  }

  /** Release a host-side lease (see `open`'s `hold`); the chat stops if nothing else keeps it. */
  release(handle: string, hold: string): void {
    if (this.live.get(handle)?.holds.delete(hold)) this.disposeIfIdle(handle);
  }

  private presenceChanged(handle: string): void {
    this.push(handle, [{ kind: "lease", clients: this.presence(handle) }]);
    for (const listener of this.presenceListeners) listener(handle);
  }

  private disposeIfIdle(handle: string): void {
    const chat = this.live.get(handle);
    if (chat && !chat.clients.size && !chat.holds.size && chat.state.phase !== "exited" && isDisposable(chat.state)) void this.close(handle, "host");
  }

  /**
   * A chat whose pi can stop to free its memory: ready, nothing running or waiting on the user, read, held by nothing
   * host-side and on no client's screen. ATP chats follow their own runner and page (`AtpRunner`).
   */
  private idle(chat: Live): boolean {
    const { state } = chat;
    if (state.phase !== "ready" || state.running || state.compacting || state.unread || state.dialogs.length || state.atp) return false;
    return !chat.holds.size && ![...chat.clients.values()].some((client) => client.shown || client.viewing);
  }

  /**
   * Stop the pi of chats idle for IDLE_STOP_MS, and of the idle chats past the IDLE_KEPT most recently active. Clients
   * leave them (`closed`); the sidebar opens one again from its session file.
   * @internal exposed for tests
   */
  stopIdle(now = Date.now()): void {
    const idle = [...this.live].filter(([, chat]) => this.idle(chat)).sort(([, a], [, b]) => b.active - a.active);
    // The spare counts as an idle chat and goes first; nor does it stay on a busy machine.
    if (idle.length >= IDLE_KEPT) void this.retireSpare(`${IDLE_KEPT} idle chats`);
    else if (busy()) void this.retireSpare("machine busy");
    idle.forEach(([handle, chat], index) => {
      if (index < IDLE_KEPT && now - chat.active < IDLE_STOP_MS) return;
      const minutes = Math.round((now - chat.active) / 60_000);
      log.info(`pi·${handle.slice(0, 4)}`, `stopped: idle ${minutes} min${index >= IDLE_KEPT ? `, more than ${IDLE_KEPT} idle chats` : ""}`);
      void this.close(handle, "host");
    });
  }

  // ── Spare pi ─────────────────────────────────────────────────────────────────

  /** Start a spare pi for `cwd` in SPARE_DELAY_MS, unless another chat asks for one first. */
  private planSpare(cwd: string): void {
    if (this.closing) return;
    clearTimeout(this.spareTimer);
    this.spareTimer = setTimeout(() => void this.spawnSpare(cwd), SPARE_DELAY_MS);
    this.spareTimer.unref?.();
  }

  /**
   * Start a pi for the next New chat in `cwd`: one spare at most, for the folder of the chat opened last. Not while the
   * machine is busy or the idle chats fill IDLE_KEPT (the spare counts as one). A current spare for `cwd` stays.
   * @internal exposed for tests
   */
  async spawnSpare(cwd: string): Promise<void> {
    const turn = ++this.spareTurn;
    const full = [...this.live.values()].filter((chat) => this.idle(chat)).length >= IDLE_KEPT;
    if (this.closing || full || busy()) return void this.retireSpare(full ? `${IDLE_KEPT} idle chats` : "machine busy");
    const trust = await this.trustOf(cwd).catch(() => undefined);
    const features = await this.features().catch(() => NONE);
    const inputs = await piInputs(cwd);
    await this.bridge.start();
    if (turn !== this.spareTurn) return;
    const current = this.spare;
    const why = current && (current.cwd === cwd ? stale(current, trust, JSON.stringify(features), inputs) : "another folder");
    if (current && !why) return;
    if (why) void this.retireSpare(why);
    const handle = this.newHandle();
    const tag = `pi·${handle.slice(0, 4)}`;
    log.info(tag, `spare+ for ${cwd}`);
    const relay = new Relay((exit) => {
      if (this.spare?.relay === relay) void this.retireSpare(`pi exited (${exit.error ?? exit.signal ?? `code ${exit.code}`})`);
    });
    const pi = new PiProcess({ cwd, tag, ...this.piArgs(handle, trust, undefined, features) }, relay);
    const timer = setTimeout(() => this.spare?.pi === pi && void this.retireSpare(`unused for ${SPARE_KEPT_MS / 60_000} min`), SPARE_KEPT_MS);
    timer.unref?.();
    this.spare = { handle, tag, cwd, trust, features: JSON.stringify(features), inputs, pi, relay, since: Date.now(), timer };
  }

  /** The spare, for a New chat in `cwd` that would start the same pi; a stale one stops instead. */
  private async takeSpare(cwd: string, trust: boolean | undefined, features: SessionFeatures): Promise<Spare | undefined> {
    const spare = this.spare;
    if (spare?.cwd !== cwd) return undefined;
    const inputs = await piInputs(cwd);
    if (this.spare !== spare) return undefined;
    const why = stale(spare, trust, JSON.stringify(features), inputs);
    if (why) return void this.retireSpare(why);
    this.spare = undefined;
    clearTimeout(spare.timer);
    return spare;
  }

  /** Stop the spare pi, and a spawn still on its way (settings or features changed, unused, a busy machine, quit). */
  retireSpare(reason: string): Promise<void> {
    this.spareTurn++;
    const spare = this.spare;
    if (!spare) return Promise.resolve();
    this.spare = undefined;
    clearTimeout(spare.timer);
    this.bridge.unregister(spare.handle);
    log.info(spare.tag, `spare- ${reason}`);
    return spare.pi.close();
  }

  /** The directory a live chat runs in (its worktree for worktree chats). */
  cwdOf(handle: string): string | undefined {
    return this.live.get(handle)?.cwd;
  }

  /**
   * The chat behind a bridge request: its project and pi's current session file (asked live, since /new, /resume
   * and forks switch files). pi answers commands while one of its tools waits on the bridge.
   */
  async identify(handle: string): Promise<{ path: string; cwd: string }> {
    const cwd = this.live.get(handle)?.cwd;
    if (!cwd) throw new Error("session is not running");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("pi did not report its session file")), 5000)));
    const state = await Promise.race([this.command(handle, { type: "get_state" }), timeout]).finally(() => clearTimeout(timer));
    const path = (state.data as RpcSessionState | undefined)?.sessionFile;
    if (!path) throw new Error("this chat has no session file, so it cannot be on the board");
    return { path, cwd };
  }

  /** Called when a chat's run finishes (agent_end without a retry) or its pi process exits. Returns an unsubscribe. */
  onRunEnd(listener: (handle: string) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Called when a run settles (agent_settled), after the state reflects it and `unread` is set. Returns an unsubscribe. */
  onSettled(listener: (handle: string, outcome: RunOutcome) => void): () => void {
    this.settleListeners.add(listener);
    return () => this.settleListeners.delete(listener);
  }

  /** Called when a client attaches to, detaches from or starts or stops viewing a chat. Returns an unsubscribe. */
  onPresence(listener: (handle: string) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  /** Called when a chat's pi process exits (the session closed). Returns an unsubscribe. */
  onExit(listener: (handle: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** How many chats are mid-run. */
  get running(): number {
    return this.working.size;
  }

  /** Called whenever the number of running chats changes. Returns an unsubscribe. */
  onRunningChange(listener: () => void): () => void {
    this.runningListeners.add(listener);
    return () => this.runningListeners.delete(listener);
  }

  private started(handle: string): void {
    if (!this.working.has(handle)) {
      this.working.add(handle);
      for (const listener of this.runningListeners) listener();
    }
  }

  private ended(handle: string): void {
    if (this.working.delete(handle)) for (const listener of this.runningListeners) listener();
    for (const listener of this.endListeners) {
      try {
        listener(handle);
      } catch (error) {
        log.warn("pi", `run-end listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The chat's name as the user sees it, for labels in other apps. */
  async chatName(handle: string): Promise<string | undefined> {
    const state = await this.command(handle, { type: "get_state" });
    return (state.data as RpcSessionState | undefined)?.sessionName || undefined;
  }

  /** Ask the user to pick one option on this chat's approval card. The id is main's own, so the answer is read here
   * from the window and never forwarded to pi, and nothing holding the bridge token can answer it. Undefined when
   * the user dismisses it, the wait runs out or the chat ends. With yolo on, its allowing option without a card. */
  requestChoice(handle: string, title: string, options: string[]): Promise<string | undefined> {
    if (!this.live.has(handle)) return Promise.resolve(undefined);
    const allow = this.yolo() ? yoloOption(options) : undefined;
    if (allow !== undefined) {
      log.info(`pi·${handle.slice(0, 4)}`, `yolo approved "${title}" (${allow})`);
      return Promise.resolve(allow);
    }
    const id = `pigna-choice-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(undefined);
        this.settleDialog(handle, id, "desktop", "timeout");
      }, APPROVAL_TIMEOUT_MS);
      const settle = (value: string | undefined) => {
        clearTimeout(timer);
        this.choices.delete(id);
        resolve(value);
      };
      this.choices.set(id, { handle, resolve: settle });
      this.push(handle, [{ kind: "rpc", record: { type: "extension_ui_request", id, method: "select", title, options, timeout: APPROVAL_TIMEOUT_MS } }]);
    });
  }

  private settleChoices(handle: string): void {
    for (const choice of [...this.choices.values()]) if (choice.handle === handle) choice.resolve(undefined);
  }

  /** Keep the set of waiting dialogs in step with the events: a request opens one, a resolution closes it. */
  private trackDialog(handle: string, chat: Live, event: HostEvent): void {
    if (event.kind === "rpc" && event.record.type === "extension_ui_request" && DIALOG_METHODS.has(event.record.method)) {
      const { id } = event.record;
      const timeout = "timeout" in event.record ? event.record.timeout : undefined;
      // pi gives up on its own dialogs after `timeout`; mirror that. Main's choices run their own timer.
      const timer = timeout && !this.choices.has(id) ? setTimeout(() => this.settleDialog(handle, id, "desktop", "timeout"), timeout) : undefined;
      timer?.unref?.();
      chat.dialogs.set(id, timer);
    } else if (event.kind === "dialog_resolved") {
      clearTimeout(chat.dialogs.get(event.id));
      chat.dialogs.delete(event.id);
      chat.resolved.add(event.id);
      if (chat.resolved.size > RESOLVED_KEPT) chat.resolved.delete(chat.resolved.values().next().value as string);
    }
  }

  /** Close one waiting dialog (if still waiting) and tell every client. */
  private settleDialog(handle: string, id: string, by: Actor, outcome: DialogOutcome): boolean {
    if (!this.live.get(handle)?.dialogs.has(id)) return false;
    this.push(handle, [{ kind: "dialog_resolved", id, by, outcome }]);
    return true;
  }

  /** The chat ends: its waiting dialogs end with it. */
  private settleDialogs(handle: string, outcome: DialogOutcome): void {
    for (const id of [...(this.live.get(handle)?.dialogs.keys() ?? [])]) this.settleDialog(handle, id, "desktop", outcome);
  }

  /**
   * Answer a dialog. The first answer wins: it resolves the dialog and every client is told (`dialog_resolved`, so the
   * others drop their card); a later answer fails `already_answered`.
   */
  respondDialog(handle: string, response: ExtensionUiResponse, ctx: HostCtx = DESKTOP): void {
    const chat = this.live.get(handle);
    if (!chat) throw new HostError("not_found", "session is not running");
    const { id } = response;
    if (!chat.dialogs.has(id)) throw new HostError(chat.resolved.has(id) ? "already_answered" : "not_found", chat.resolved.has(id) ? "that dialog was already answered" : "no such dialog");
    const by = actorOf(ctx);
    const choice = this.choices.get(id);
    if (choice && choice.handle !== handle) throw new HostError("not_found", "no such dialog");
    const cancelled = "cancelled" in response && response.cancelled;
    // Marking it resolved first (push is synchronous) is what makes a concurrent second answer lose.
    this.push(handle, [{ kind: "dialog_resolved", id, by, outcome: cancelled ? "cancelled" : "answered" }]);
    if (choice) {
      log.info("pi", `approval ${id.slice(0, 18)} answered by ${typeof by === "string" ? by : `device ${by.device}`}`);
      choice.resolve("value" in response ? response.value : undefined);
    } else chat.pi.respondUi(response);
  }

  /** Explicit close: clients are told first (they leave the chat), then pi stops. */
  async close(handle: string, by: Actor | "host" = "desktop"): Promise<void> {
    const chat = this.live.get(handle);
    if (!chat) return;
    this.push(handle, [{ kind: "closed", by }]);
    await chat.pi.close();
  }

  async closeAll(): Promise<void> {
    clearInterval(this.idleCheck);
    this.closing = true;
    clearTimeout(this.spareTimer);
    await Promise.all([this.retireSpare("quit"), ...[...this.live.values()].map((chat) => chat.pi.close())]);
  }
}

/** A summary holds primitives and `settled`, which is replaced (never edited) when a run settles: a shallow compare. */
function sameSummary(a: AttentionSummary, b: AttentionSummary): boolean {
  const keys = Object.keys(b) as (keyof AttentionSummary)[];
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}
