// Pure session reducer: pi RPC events (and session-file hydration) -> renderable session state.
// Immutable updates so unchanged transcript items keep their identity for memoized rendering.
import type { HostEvent } from "../../../shared/ipc";
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
  ThinkingLevel,
  ToolResultLike,
  UserMessage,
} from "../../../shared/protocol";
import { parsePartialJson } from "./partial-json";

export interface ToolRun {
  status: "running" | "done" | "error";
  partial?: ToolResultLike;
  result?: ToolResultLike;
  startedAt?: number;
  endedAt?: number;
}

export interface BlockTime {
  start: number;
  end?: number;
}

export type Item =
  | { kind: "user"; key: string; message: UserMessage }
  | {
      kind: "assistant";
      key: string;
      message: AssistantMessage;
      streaming: boolean;
      /** Raw argument JSON per content index while a tool call streams. */
      partialArgs?: Record<number, string>;
      times?: Record<number, BlockTime>;
    }
  | { kind: "bash"; key: string; message: BashExecutionMessage }
  | { kind: "custom"; key: string; message: CustomMessage }
  | { kind: "compaction"; key: string; summary: string; tokensBefore: number }
  | { kind: "branch"; key: string; summary: string }
  | { kind: "notice"; key: string; level: "info" | "error"; text: string };

export type AssistantItem = Extract<Item, { kind: "assistant" }>;

export interface SessionState {
  handle: string;
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
  name?: string;
  phase: "starting" | "ready" | "exited";
  exit?: { code: number | null; signal: string | null; error?: string; stderrTail: string };
  model?: Model;
  /** From the session file, until pi reports the live model. */
  modelRef?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  running: boolean;
  runStartedAt?: number;
  compacting?: string;
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; at: number };
  queue: { steering: string[]; followUp: string[] };
  dialogs: ExtensionUiDialog[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  editorText?: { text: string; nonce: number };
  title?: string;
  stats?: SessionStats;
  /** Set once the user prompts from studio; such sessions stay alive when switching away. */
  prompted: boolean;
  /** The file was written shortly before studio opened it: possibly live in another pi. */
  recentWriteAt?: number;
  items: Item[];
  tools: Record<string, ToolRun>;
  seq: number;
}

export function createSession(handle: string, cwd: string, sessionPath?: string): SessionState {
  return {
    handle,
    cwd,
    sessionPath,
    phase: "starting",
    running: false,
    queue: { steering: [], followUp: [] },
    dialogs: [],
    statuses: {},
    widgets: {},
    prompted: false,
    items: [],
    tools: {},
    seq: 0,
  };
}

// ── Hydration ────────────────────────────────────────────────────────────────

export function hydrate(state: SessionState, entries: SessionEntry[]): SessionState {
  let next: SessionState = { ...state, items: [], tools: {}, seq: 0 };
  for (const entry of entries) {
    switch (entry.type) {
      case "message":
        next = addMessage(next, entry.message, Date.parse(entry.timestamp) || entry.message.timestamp);
        break;
      case "compaction":
        next = pushItem(next, { kind: "compaction", summary: entry.summary, tokensBefore: entry.tokensBefore });
        break;
      case "branch_summary":
        next = pushItem(next, { kind: "branch", summary: entry.summary });
        break;
      case "custom_message":
        if (entry.display) {
          next = addMessage(next, { role: "custom", customType: entry.customType, content: entry.content, display: true, details: entry.details, timestamp: Date.parse(entry.timestamp) }, 0);
        }
        break;
      case "session_info":
        next = { ...next, name: entry.name || undefined };
        break;
      case "model_change":
        next = { ...next, modelRef: { provider: entry.provider, modelId: entry.modelId } };
        break;
      case "thinking_level_change":
        next = { ...next, thinkingLevel: entry.thinkingLevel };
        break;
    }
  }
  return next;
}

// ── Host events ──────────────────────────────────────────────────────────────

export function reduceHostEvent(state: SessionState, event: HostEvent, now: number): SessionState {
  switch (event.kind) {
    case "ready":
      return {
        ...state,
        phase: "ready",
        model: event.state.model,
        thinkingLevel: event.state.thinkingLevel,
        sessionId: event.state.sessionId,
        sessionPath: event.state.sessionFile ?? state.sessionPath,
        name: event.state.sessionName ?? state.name,
        running: event.state.isStreaming || state.running,
      };
    case "exit":
      return {
        ...settle(state),
        phase: "exited",
        dialogs: [],
        exit: { code: event.code, signal: event.signal, error: event.error, stderrTail: event.stderrTail },
      };
    case "rpc":
      return event.record.type === "extension_ui_request"
        ? reduceUiRequest(state, event.record, now)
        : reduceSessionEvent(state, event.record, now);
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
      return state.running ? state : { ...state, running: true, runStartedAt: now };
    case "agent_settled":
      return settle(state);
    case "message_start":
      return event.message.role === "assistant" ? startAssistant(state, event.message) : state;
    case "message_update":
      return updateAssistant(state, event.assistantMessageEvent, event.usage, now);
    case "message_end":
      return event.message.role === "assistant" ? endAssistant(state, event.message, now) : addMessage(state, event.message, now);
    case "tool_execution_start":
      return setTool(state, event.toolCallId, { status: "running", startedAt: now });
    case "tool_execution_update":
      return setTool(state, event.toolCallId, { status: "running", partial: event.partialResult });
    case "tool_execution_end":
      return setTool(state, event.toolCallId, { status: event.isError ? "error" : "done", result: event.result, endedAt: now });
    case "queue_update":
      return { ...state, queue: { steering: event.steering, followUp: event.followUp } };
    case "session_info_changed":
      return { ...state, name: event.name || undefined };
    case "thinking_level_changed":
      return { ...state, thinkingLevel: event.level };
    case "compaction_start":
      return { ...state, compacting: event.reason };
    case "compaction_end": {
      const next = { ...state, compacting: undefined };
      if (event.result) return pushItem(next, { kind: "compaction", summary: event.result.summary, tokensBefore: event.result.tokensBefore });
      if (event.errorMessage) return pushItem(next, { kind: "notice", level: "error", text: `Compaction failed: ${event.errorMessage}` });
      return next;
    }
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

function settle(state: SessionState): SessionState {
  // A run that ends mid-stream (abort, crash) must not leave spinners behind.
  const items = state.items.map((item) => (item.kind === "assistant" && item.streaming ? { ...item, streaming: false, partialArgs: undefined } : item));
  const tools = { ...state.tools };
  for (const [id, run] of Object.entries(tools)) if (run.status === "running") tools[id] = { ...run, status: "error", endedAt: run.endedAt };
  return { ...state, items, tools, running: false, runStartedAt: undefined, compacting: undefined, retry: undefined };
}

// ── Messages ─────────────────────────────────────────────────────────────────

function addMessage(state: SessionState, message: AgentMessage, at: number): SessionState {
  switch (message.role) {
    case "user":
      return pushItem(state, { kind: "user", message });
    case "assistant":
      return pushItem(state, { kind: "assistant", message, streaming: false });
    case "toolResult":
      return setTool(state, message.toolCallId, {
        status: message.isError ? "error" : "done",
        result: { content: message.content, details: message.details },
        endedAt: state.tools[message.toolCallId]?.endedAt ?? at,
      });
    case "bashExecution":
      return pushItem(state, { kind: "bash", message });
    case "custom":
      return message.display ? pushItem(state, { kind: "custom", message }) : state;
    case "compactionSummary":
      return pushItem(state, { kind: "compaction", summary: message.summary, tokensBefore: message.tokensBefore });
    case "branchSummary":
      return pushItem(state, { kind: "branch", summary: message.summary });
    default:
      return state;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewItem = DistributiveOmit<Item, "key">;

function pushItem(state: SessionState, item: NewItem): SessionState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { ...item, key: `i${seq}` } as Item] };
}

function setTool(state: SessionState, id: string, patch: Partial<ToolRun>): SessionState {
  const previous = state.tools[id];
  return { ...state, tools: { ...state.tools, [id]: { ...previous, ...patch } as ToolRun } };
}

function startAssistant(state: SessionState, message: AssistantMessage): SessionState {
  return pushItem(state, { kind: "assistant", message: { ...message, content: [...message.content] }, streaming: true, times: {} });
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
  if (index === -1) return pushItem(state, { kind: "assistant", message, streaming: false });
  const item = state.items[index] as AssistantItem;
  const times = { ...item.times };
  for (const key of Object.keys(times)) {
    const time = times[Number(key)];
    if (time && time.end === undefined) times[Number(key)] = { ...time, end: now };
  }
  return replaceItem(state, index, { ...item, message, streaming: false, partialArgs: undefined, times });
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
      partialArgs = { ...partialArgs, [i]: "" };
      times[i] = { start: now };
      break;
    case "toolcall_delta": {
      const raw = (partialArgs?.[i] ?? "") + event.delta;
      partialArgs = { ...partialArgs, [i]: raw };
      if (block?.type === "toolCall") content[i] = { ...block, arguments: parsePartialJson(raw) ?? block.arguments };
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
