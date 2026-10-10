// Pure session reducer: pi RPC events (and session-file hydration) -> renderable session state.
// Immutable updates so unchanged transcript items keep their identity for memoized rendering; hydrate
// alone mutates the fresh state it builds.
import type { AtpSession } from "./atp";
import type { HostEvent } from "./host-api";
import type { TurnOutline } from "./turn-outline";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  BashExecutionMessage,
  CustomMessage,
  ExtensionUiDialog,
  ExtensionUiRequest,
  Model,
  SessionEntry,
  SessionEvent,
  SessionStats,
  TextContent,
  ThinkingLevel,
  ToolResultLike,
  UserMessage,
} from "./protocol";
import { appendPartialJson, completePartialJson, EMPTY_PARTIAL_JSON, type PartialJson } from "./partial-json";
import { isTriage } from "./task-prompts";

export interface ToolRun {
  status: "running" | "done" | "error";
  partial?: ToolResultLike;
  result?: ToolResultLike;
  startedAt?: number;
  endedAt?: number;
  /** Main dropped `result` (an older turn's big output, `evictPayloads`): about its JSON size. Pages read it back. */
  evicted?: number;
}

export interface BlockTime {
  start: number;
  end?: number;
}

type CompactionReason = Extract<SessionEvent, { type: "compaction_start" }>["reason"];

interface CompactionBase {
  kind: "compaction";
  key: string;
  reason?: CompactionReason;
  startedAt?: number;
  endedAt?: number;
}

export type CompactionItem = CompactionBase & (
  | { status: "running"; startedAt: number; retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; waiting: boolean } }
  | { status: "done"; summary: string; tokensBefore: number }
  | { status: "error"; errorMessage: string }
  | { status: "aborted" }
);

export type Item =
  /**
   * `steer`: delivered into a running turn (pi's steering queue), so it belongs to that turn. `evicted`: main dropped
   * the data of its images (an older turn, `evictPayloads`), about this many characters; pages read it back.
   */
  | { kind: "user"; key: string; message: UserMessage; steer?: boolean; evicted?: number }
  | {
      kind: "assistant";
      key: string;
      message: AssistantMessage;
      streaming: boolean;
      /** Argument JSON scanned so far per content index while a tool call streams. */
      partialArgs?: Record<number, StreamingArgs>;
      times?: Record<number, BlockTime>;
      /** When the response started (`message_start`, or the message's own timestamp read from the session file) and
       * ended (`message_end`, or its entry's timestamp), for the tok/s readout. */
      span?: { start: number; end?: number };
      /** The runs of this message's tool calls, by call id: a tool update copies this item alone. */
      runs?: Record<string, ToolRun>;
    }
  | { kind: "bash"; key: string; message: BashExecutionMessage }
  | { kind: "custom"; key: string; message: CustomMessage }
  | CompactionItem
  | { kind: "branch"; key: string; summary: string }
  | { kind: "notice"; key: string; level: "info" | "error"; text: string };

export type AssistantItem = Extract<Item, { kind: "assistant" }>;

/** A streaming tool call's arguments and when they were last parsed into the block. */
export interface StreamingArgs {
  json: PartialJson;
  /** Unset until the first parse. */
  parsedAt?: number;
}

/** Arguments up to this size parse on every delta; larger ones at most every ARGS_PARSE_MS. */
const ARGS_PARSE_EVERY_DELTA = 8 * 1024;
const ARGS_PARSE_MS = 100;

export interface SessionState {
  handle: string;
  cwd: string;
  /** An ATP worker or orchestrator: started by the ATP page, kept off the sidebar (src/shared/atp.ts). */
  atp?: AtpSession;
  sessionPath?: string;
  sessionId?: string;
  name?: string;
  phase: "starting" | "ready" | "exited";
  exit?: { code: number | null; signal: string | null; error?: string; stderrTail: string };
  model?: Model;
  /** From the session file, until pi reports the live model. */
  modelRef?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** pi's autoCompactionEnabled (get_state). */
  autoCompaction?: boolean;
  running: boolean;
  runStartedAt?: number;
  compacting?: Extract<CompactionItem, { status: "running" }>;
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; at: number };
  queue: { steering: string[]; followUp: string[] };
  /** Every text seen in the queues during this run, to tell a delivered steer from a follow-up. */
  queueSeen: { steering: string[]; followUp: string[] };
  /** Set by agent_start: the next user message is the run's own prompt, never a steer. */
  awaitingPrompt?: boolean;
  dialogs: ExtensionUiDialog[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  editorText?: { text: string; nonce: number };
  title?: string;
  stats?: SessionStats;
  /** Opened from an existing session file (as opposed to a new chat started in pi-gna). */
  fromDisk: boolean;
  /** Opened from the sidebar and its history is still being read: the sidebar's title stands in meanwhile. */
  loading?: { title: string };
  /** A client's paged view of the chat: one line for each turn whose prompt the host has and it has not loaded. */
  earlier?: TurnOutline[];
  /** The last of the `earlier` turns came in part: this many of its items, from its prompt, are still on the host. */
  earlierOffset?: number;
  /** Set once the user prompts from pi-gna; such sessions stay alive when switching away. */
  prompted: boolean;
  /** A run finished while you were not looking (another chat open, or the window unfocused), and how. */
  unread?: RunOutcome;
  items: Item[];
  seq: number;
}

export function createSession(handle: string, cwd: string, sessionPath?: string, atp?: AtpSession): SessionState {
  return {
    handle,
    cwd,
    atp,
    sessionPath,
    phase: "starting",
    running: false,
    queue: { steering: [], followUp: [] },
    queueSeen: { steering: [], followUp: [] },
    dialogs: [],
    statuses: {},
    widgets: {},
    fromDisk: sessionPath !== undefined,
    prompted: false,
    items: [],
    seq: 0,
  };
}

// ── Hydration ────────────────────────────────────────────────────────────────

// Builds one new state, mutating only its own fresh items and their runs: copying them per entry, as the live
// reducer does, is quadratic (seconds for a 10k-entry session). Same keys and output as folding the entries
// through the reducer.
export function hydrate(state: SessionState, entries: SessionEntry[]): SessionState {
  const next: SessionState = { ...state, items: [], compacting: undefined, seq: 0 };
  const add = (message: AgentMessage, at: number) => applyChange(next, messageChange(next, message, at));
  for (const entry of entries) {
    switch (entry.type) {
      case "message":
        add(entry.message, Date.parse(entry.timestamp) || entry.message.timestamp);
        break;
      case "compaction":
        appendItem(next, { kind: "compaction", status: "done", summary: entry.summary, tokensBefore: entry.tokensBefore });
        break;
      case "branch_summary":
        appendItem(next, { kind: "branch", summary: entry.summary });
        break;
      case "custom_message":
        if (entry.display) {
          add({ role: "custom", customType: entry.customType, content: entry.content, display: true, details: entry.details, timestamp: Date.parse(entry.timestamp) }, 0);
        }
        break;
      case "session_info":
        next.name = entry.name || undefined;
        break;
      case "model_change":
        next.modelRef = { provider: entry.provider, modelId: entry.modelId };
        break;
      case "thinking_level_change":
        next.thinkingLevel = entry.thinkingLevel;
        break;
    }
  }
  // Ready/start can arrive before the session-file read completes. Keep that live record, with a
  // fresh key after hydration so it cannot collide with the rebuilt history.
  if (state.compacting) {
    const { key: _key, ...pending } = state.compacting;
    appendItem(next, pending);
    next.compacting = next.items.at(-1) as SessionState["compacting"];
  }
  return next;
}

/** Hydration only: append to the state hydrate is building. */
function appendItem(state: SessionState, item: NewItem): void {
  state.seq += 1;
  state.items.push({ ...item, key: `i${state.seq}` } as Item);
}

/** Hydration only: apply a message's change to the state hydrate is building. */
function applyChange(state: SessionState, change: MessageChange): void {
  if (!change) return;
  if ("item" in change) return appendItem(state, change.item);
  const item = state.items[toolOwner(state.items, change.tool)];
  if (item?.kind === "assistant") (item.runs ??= {})[change.tool] = { ...item.runs[change.tool], ...change.patch } as ToolRun;
}

// ── Host events ──────────────────────────────────────────────────────────────

export function reduceHostEvent(state: SessionState, event: HostEvent, now: number): SessionState {
  switch (event.kind) {
    case "ready": {
      const next: SessionState = {
        ...state,
        phase: "ready",
        model: event.state.model,
        thinkingLevel: event.state.thinkingLevel,
        autoCompaction: event.state.autoCompactionEnabled,
        sessionId: event.state.sessionId,
        sessionPath: event.state.sessionFile ?? state.sessionPath,
        name: event.state.sessionName ?? state.name,
        running: event.state.isStreaming || state.running,
      };
      // get_state resolves asynchronously: a newer lifecycle end can already have been reduced.
      const endedLiveCompaction = next.items.some((item) => item.kind === "compaction" && item.endedAt !== undefined);
      return event.state.isCompacting && !next.compacting && !endedLiveCompaction ? startCompaction(next, now) : next;
    }
    case "exit":
      return {
        ...settle(state, now),
        phase: "exited",
        dialogs: [],
        exit: { code: event.code, signal: event.signal, error: event.error, stderrTail: event.stderrTail },
      };
    case "rpc":
      return event.record.type === "extension_ui_request"
        ? reduceUiRequest(state, event.record, now)
        : reduceSessionEvent(state, event.record, now);
    case "dialog_resolved": {
      // Answered on another client (or cancelled/timed out host-side): drop the card here too.
      const dialogs = state.dialogs.filter((dialog) => dialog.id !== event.id);
      return dialogs.length === state.dialogs.length ? state : { ...state, dialogs };
    }
    // Lease changes and explicit closes concern the client's navigation, not the transcript.
    case "lease":
    case "closed":
      return state;
  }
}

function reduceUiRequest(state: SessionState, request: ExtensionUiRequest, now: number): SessionState {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return { ...state, dialogs: [...state.dialogs, request] };
    case "setStatus": {
      const statuses = { ...state.statuses };
      if (request.statusText) statuses[request.statusKey] = request.statusText;
      else delete statuses[request.statusKey];
      return { ...state, statuses };
    }
    case "setWidget": {
      const widgets = { ...state.widgets };
      if (request.widgetLines?.length) {
        widgets[request.widgetKey] = { lines: request.widgetLines, placement: request.widgetPlacement ?? "aboveEditor" };
      } else delete widgets[request.widgetKey];
      return { ...state, widgets };
    }
    case "setTitle":
      return { ...state, title: request.title };
    case "set_editor_text":
      return { ...state, editorText: { text: request.text, nonce: now } };
    default:
      return state; // notify is surfaced as a toast by the app layer
  }
}

export function reduceSessionEvent(state: SessionState, event: SessionEvent, now: number): SessionState {
  switch (event.type) {
    case "agent_start":
      return state.running ? { ...state, awaitingPrompt: true } : { ...state, running: true, runStartedAt: now, awaitingPrompt: true };
    case "agent_settled":
      return settle(state, now);
    case "message_start":
      return event.message.role === "assistant" ? startAssistant(state, event.message, now) : state;
    case "message_update":
      return updateAssistant(state, event.assistantMessageEvent, event.usage, now);
    case "message_end":
      if (event.message.role === "assistant") return endAssistant(state, event.message, now);
      if (event.message.role === "user") {
        const steer = !state.awaitingPrompt && isLiveSteer(state, event.message);
        return { ...addMessage(state, event.message, now, steer), awaitingPrompt: false };
      }
      return addMessage(state, event.message, now);
    case "tool_execution_start":
      return setTool(state, event.toolCallId, { status: "running", startedAt: now });
    case "tool_execution_update":
      return setTool(state, event.toolCallId, { status: "running", partial: event.partialResult });
    case "tool_execution_end":
      // The result replaces the partial output (clients show `result ?? partial`).
      return setTool(state, event.toolCallId, { status: event.isError ? "error" : "done", result: event.result, partial: undefined, endedAt: now });
    case "queue_update":
      return {
        ...state,
        queue: { steering: event.steering, followUp: event.followUp },
        queueSeen: {
          steering: [...new Set([...state.queueSeen.steering, ...event.steering])],
          followUp: [...new Set([...state.queueSeen.followUp, ...event.followUp])],
        },
      };
    case "session_info_changed":
      return { ...state, name: event.name || undefined };
    case "thinking_level_changed":
      return { ...state, thinkingLevel: event.level };
    case "compaction_start":
      return startCompaction(state, now, event.reason);
    case "compaction_end": {
      const base = { kind: "compaction" as const, reason: event.reason, startedAt: state.compacting?.startedAt, endedAt: now };
      const item: DistributiveOmit<CompactionItem, "key"> = event.aborted
        ? { ...base, status: "aborted" }
        : event.result
          ? { ...base, status: "done", summary: event.result.summary, tokensBefore: event.result.tokensBefore }
          : event.errorMessage
            ? { ...base, status: "error", errorMessage: event.errorMessage }
            : { ...base, status: "aborted" };
      const index = state.items.findIndex((entry) => entry.key === state.compacting?.key);
      const next = { ...state, compacting: undefined };
      return index < 0 ? pushItem(next, item) : replaceItem(next, index, { ...item, key: state.items[index]!.key });
    }
    case "summarization_retry_scheduled":
      return updateCompaction(state, (item) => ({ ...item, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage, waiting: true } }));
    case "summarization_retry_attempt_start":
      return event.source === "compaction"
        ? updateCompaction(state, (item) => item.retry ? { ...item, retry: { ...item.retry, waiting: false } } : item)
        : state;
    case "summarization_retry_finished":
      return updateCompaction(state, (item) => ({ ...item, retry: undefined }));
    case "auto_retry_start":
      return { ...state, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage, at: now } };
    case "auto_retry_end": {
      const next = { ...state, retry: undefined };
      return event.success ? next : pushItem(next, { kind: "notice", level: "error", text: event.finalError ?? "Retry failed" });
    }
    case "extension_error":
      return pushItem(state, { kind: "notice", level: "error", text: `Extension error (${basename(event.extensionPath)}, ${event.event}): ${event.error}` });
    default:
      return state;
  }
}

/**
 * A pi record as clients get it: without what they never read. Signatures are opaque provider blobs (about 3.5 KB a
 * thinking block) that pi resends from its session file; `turn_end` and `agent_end` repeat the messages that
 * message_end and tool_execution_end brought, and tool events the arguments of their call. The host reduces and
 * publishes the lean record; history read from the session file is leaned by `hydrate`.
 */
export function leanRecord(record: SessionEvent | ExtensionUiRequest): SessionEvent | ExtensionUiRequest {
  switch (record.type) {
    case "message_start":
    case "message_end":
      return record.message.role === "assistant" ? { ...record, message: leanMessage(record.message) } : record;
    case "turn_end":
      return { type: "turn_end" };
    case "agent_end":
      return { type: "agent_end", willRetry: record.willRetry };
    case "tool_execution_start":
    case "tool_execution_update": {
      const { args: _args, ...lean } = record;
      return lean;
    }
    default:
      return record;
  }
}

/** The message without its blocks' signatures; the same object when it has none. */
function leanMessage(message: AssistantMessage): AssistantMessage {
  const signed = (block: AssistantMessage["content"][number]) =>
    (block.type === "thinking" && block.thinkingSignature !== undefined) || (block.type === "text" && block.textSignature !== undefined);
  if (!message.content.some(signed)) return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (!signed(block)) return block;
      if (block.type === "thinking") {
        const { thinkingSignature: _signature, ...lean } = block;
        return lean;
      }
      const { textSignature: _signature, ...lean } = block as TextContent;
      return lean;
    }),
  };
}

function startCompaction(state: SessionState, now: number, reason?: CompactionReason): SessionState {
  if (state.compacting) return reason ? updateCompaction(state, (item) => ({ ...item, reason })) : state;
  const next = pushItem(state, { kind: "compaction", status: "running", reason, startedAt: now });
  return { ...next, compacting: next.items.at(-1) as SessionState["compacting"] };
}

function updateCompaction(state: SessionState, update: (item: NonNullable<SessionState["compacting"]>) => NonNullable<SessionState["compacting"]>): SessionState {
  const previous = state.compacting;
  if (!previous) return state;
  const index = state.items.findIndex((item) => item.key === previous.key);
  if (index < 0) return state;
  const compacting = update(previous);
  return { ...replaceItem(state, index, compacting), compacting };
}

function settle(state: SessionState, now: number): SessionState {
  // A run that ends mid-stream (abort, crash) must not leave spinners behind.
  const items: Item[] = state.items.map((item) => {
    if (item.kind === "assistant") {
      const runs = failRunning(item.runs);
      if (item.streaming || runs !== item.runs) return { ...item, streaming: false, partialArgs: undefined, runs };
    }
    if (item.kind === "compaction" && item.status === "running") return { kind: "compaction", key: item.key, reason: item.reason, startedAt: item.startedAt, endedAt: now, status: "aborted" };
    return item;
  });
  return {
    ...state,
    items,
    running: false,
    runStartedAt: undefined,
    compacting: undefined,
    retry: undefined,
    awaitingPrompt: false,
    queueSeen: { steering: [], followUp: [] },
  };
}

/** The runs with the ones still running marked failed (their end never came): the same object when none was. */
function failRunning(runs: Record<string, ToolRun> | undefined): Record<string, ToolRun> | undefined {
  let failed: Record<string, ToolRun> | undefined;
  for (const id in runs) if (runs[id]!.status === "running") (failed ??= { ...runs })[id] = { ...runs[id]!, status: "error" };
  return failed ?? runs;
}

export function userText(message: UserMessage): string {
  const content = message.content;
  return (typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).trim();
}

/**
 * A user message that arrives right after a tool-using assistant message was delivered into the running
 * turn: pi injects steers after the current tool calls, before the next model call. Every user message
 * after a tool result in the user's sessions is a steer, so this also classifies sessions read from disk.
 */
function followsToolUse(state: Pick<SessionState, "items">): boolean {
  const last = state.items.at(-1);
  return last?.kind === "assistant" && last.message.stopReason === "toolUse";
}

/** Live: the queue says what the user queued as a steer or a follow-up; fall back to the tool-use rule. */
function isLiveSteer(state: SessionState, message: UserMessage): boolean {
  const text = userText(message);
  if (state.queueSeen.steering.some((queued) => queued.trim() === text)) return true;
  if (state.queueSeen.followUp.some((queued) => queued.trim() === text)) return false;
  return followsToolUse(state);
}

// ── Messages ─────────────────────────────────────────────────────────────────

function addMessage(state: SessionState, message: AgentMessage, at: number, steer?: boolean): SessionState {
  const change = messageChange(state, message, at, steer);
  if (!change) return state;
  return "item" in change ? pushItem(state, change.item) : setTool(state, change.tool, change.patch);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewItem = DistributiveOmit<Item, "key">;

/** What a message adds: a transcript item, or a patch to its tool call's run. Applied immutably live, in place by hydrate. */
type MessageChange = { item: NewItem } | { tool: string; patch: Partial<ToolRun> } | undefined;

function messageChange(state: Pick<SessionState, "items">, message: AgentMessage, at: number, steer = message.role === "user" && followsToolUse(state)): MessageChange {
  switch (message.role) {
    case "user":
      return { item: steer ? { kind: "user", message, steer: true } : { kind: "user", message } };
    case "assistant":
      // Whole (from the session file): pi stamps the message when it sends the request and its entry at
      // message_end, the same span the live events give.
      return { item: { kind: "assistant", message: leanMessage(message), streaming: false, ...(at > message.timestamp && { span: { start: message.timestamp, end: at } }) } };
    case "toolResult":
      return {
        tool: message.toolCallId,
        patch: {
          status: message.isError ? "error" : "done",
          result: { content: message.content, details: message.details },
          partial: undefined,
          endedAt: toolRun(state.items, message.toolCallId)?.endedAt ?? at,
        },
      };
    case "bashExecution":
      return { item: { kind: "bash", message } };
    case "custom":
      return message.display ? { item: { kind: "custom", message } } : undefined;
    case "compactionSummary":
      return { item: { kind: "compaction", status: "done", summary: message.summary, tokensBefore: message.tokensBefore } };
    case "branchSummary":
      return { item: { kind: "branch", summary: message.summary } };
    default:
      return undefined;
  }
}

function pushItem(state: SessionState, item: NewItem): SessionState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { ...item, key: `i${seq}` } as Item] };
}

/**
 * The index of the assistant item whose message made tool call `id`, or -1. pi runs a message's tool calls right after
 * it ends, so this is the latest assistant item, past any steer delivered meanwhile. The search stops at the turn's
 * prompt: a call it does not know costs the turn, not the session.
 */
function toolOwner(items: Item[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant" && item.message.content.some((block) => block.type === "toolCall" && block.id === id)) return i;
    if (item.kind === "user" && !item.steer) break;
  }
  return -1;
}

function toolRun(items: Item[], id: string): ToolRun | undefined {
  const item = items[toolOwner(items, id)];
  return item?.kind === "assistant" ? item.runs?.[id] : undefined;
}

/** Patches the run on the item that made the call: that item alone is copied, so the rest keep their identity. */
function setTool(state: SessionState, id: string, patch: Partial<ToolRun>): SessionState {
  const index = toolOwner(state.items, id);
  if (index < 0) return state;
  const item = state.items[index] as AssistantItem;
  return replaceItem(state, index, { ...item, runs: { ...item.runs, [id]: { ...item.runs?.[id], ...patch } as ToolRun } });
}

function startAssistant(state: SessionState, message: AssistantMessage, now: number): SessionState {
  return pushItem(state, { kind: "assistant", message: { ...message, content: [...message.content] }, streaming: true, times: {}, span: { start: now } });
}

function streamingIndex(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "assistant" && item.streaming) return i;
  }
  return -1;
}

function replaceItem(state: SessionState, index: number, item: Item): SessionState {
  const items = state.items.slice();
  items[index] = item;
  return { ...state, items };
}

function endAssistant(state: SessionState, message: AssistantMessage, now: number): SessionState {
  const index = streamingIndex(state.items);
  if (index === -1) return addMessage(state, message, now); // never started here: as read from the session file
  const item = state.items[index] as AssistantItem;
  const times = { ...item.times };
  for (const key of Object.keys(times)) {
    const time = times[Number(key)];
    if (time && time.end === undefined) times[Number(key)] = { ...time, end: now };
  }
  const span = item.span && { ...item.span, end: now };
  return replaceItem(state, index, { ...item, message, streaming: false, partialArgs: undefined, times, span });
}

function updateAssistant(state: SessionState, event: AssistantMessageEvent, usage: AssistantMessage["usage"] | undefined, now: number): SessionState {
  const index = streamingIndex(state.items);
  if (index === -1 || !("contentIndex" in event)) return state;
  const item = state.items[index] as AssistantItem;
  const i = event.contentIndex;
  const content = item.message.content.slice();
  const times = { ...item.times };
  let partialArgs = item.partialArgs;
  const block = content[i];

  switch (event.type) {
    case "text_start":
      content[i] = { type: "text", text: "" };
      times[i] = { start: now };
      break;
    case "text_delta":
      content[i] = { type: "text", text: (block?.type === "text" ? block.text : "") + event.delta };
      break;
    case "text_end":
      content[i] = { type: "text", text: event.content };
      times[i] = { start: times[i]?.start ?? now, end: now };
      break;
    case "thinking_start":
      content[i] = { type: "thinking", thinking: "" };
      times[i] = { start: now };
      break;
    case "thinking_delta":
      content[i] = { type: "thinking", thinking: (block?.type === "thinking" ? block.thinking : "") + event.delta };
      break;
    case "thinking_end":
      content[i] = { type: "thinking", thinking: event.content };
      times[i] = { start: times[i]?.start ?? now, end: now };
      break;
    case "toolcall_start":
      content[i] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
      partialArgs = { ...partialArgs, [i]: { json: EMPTY_PARTIAL_JSON } };
      times[i] = { start: now };
      break;
    case "toolcall_delta": {
      // Each delta scans only its own text; the whole text is parsed again only when it is small or
      // ARGS_PARSE_MS has passed (toolcall_end replaces the arguments with the final ones anyway).
      const previous = partialArgs?.[i];
      const json = appendPartialJson(previous?.json ?? EMPTY_PARTIAL_JSON, event.delta);
      const due = json.text.length <= ARGS_PARSE_EVERY_DELTA || previous?.parsedAt === undefined || now - previous.parsedAt >= ARGS_PARSE_MS;
      const parsed = due && block?.type === "toolCall" ? completePartialJson(json) : undefined;
      if (parsed && block?.type === "toolCall") content[i] = { ...block, arguments: parsed };
      partialArgs = { ...partialArgs, [i]: { json, parsedAt: due ? now : previous?.parsedAt } };
      break;
    }
    case "toolcall_end": {
      content[i] = event.toolCall;
      const { [i]: _done, ...rest } = partialArgs ?? {};
      partialArgs = rest;
      times[i] = { start: times[i]?.start ?? now, end: now };
      break;
    }
  }
  const message = { ...item.message, content, usage: usage ?? item.message.usage };
  return replaceItem(state, index, { ...item, message, partialArgs, times });
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export type RunOutcome = "done" | "error";

/** How the run that just settled ended: the model or retries failed, or it finished. */
export function runOutcome(items: Item[]): RunOutcome {
  const last = items.at(-1);
  if (last?.kind === "assistant" && last.message.stopReason === "error") return "error";
  if (last?.kind === "notice" && last.level === "error") return "error";
  if (last?.kind === "compaction" && last.status === "error") return "error";
  return "done";
}

/**
 * What a chat needs from you, strongest first. Drives the sidebar mark; idle chats get none (the
 * highlighted row already marks the one you are in).
 */
export type Attention = "waiting" | "running" | "failed" | "unread" | "idle";

const ATTENTION_RANK: Record<Attention, number> = { waiting: 4, running: 3, failed: 2, unread: 1, idle: 0 };

type AttentionInput = Pick<SessionState, "dialogs" | "running" | "compacting" | "unread" | "phase">;

export function attention(session: AttentionInput): Attention {
  if (session.dialogs.length) return "waiting";
  if (session.running || session.compacting) return "running";
  if (session.phase === "exited" || session.unread === "error") return "failed";
  if (session.unread) return "unread";
  return "idle";
}

/** Strongest signal across chats (for a collapsed project), ignoring idle. */
export function strongestAttention(sessions: AttentionInput[]): Attention | undefined {
  return strongestLevel(sessions.map(attention));
}

/** Strongest of these levels, ignoring idle. */
export function strongestLevel(levels: Attention[]): Attention | undefined {
  let best: Attention | undefined;
  for (const level of levels) if (level !== "idle" && (!best || ATTENTION_RANK[level] > ATTENTION_RANK[best])) best = level;
  return best;
}

/** A preview must not be stopped by switching chats while pi is compacting it. */
export function isDisposable(session: Pick<SessionState, "prompted" | "running" | "compacting" | "unread" | "dialogs">): boolean {
  return !session.prompted && !session.running && !session.compacting && !session.unread && session.dialogs.length === 0;
}

/**
 * A new chat you have not sent anything to yet. It stays out of the sidebar (the "New chat" row stands in for
 * it) until it has a message, runs, or needs you.
 */
/** Whether the chat lists show this open chat: not an unsent draft, a card triage chat or an ATP chat (reached from the ATP page). */
export function isListed(session: Pick<SessionState, "fromDisk" | "items" | "prompted" | "running" | "dialogs" | "unread" | "name" | "atp">): boolean {
  return !isDraft(session) && !isTriage(session.name) && !session.atp;
}

export function isDraft(session: Pick<SessionState, "fromDisk" | "items" | "prompted" | "running" | "dialogs" | "unread">): boolean {
  // Not sessionPath: pi names a session file as soon as it is ready, before anything is written.
  return !session.fromDisk && !session.items.length && !session.prompted && !session.running && !session.dialogs.length && !session.unread;
}
