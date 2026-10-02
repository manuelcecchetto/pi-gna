// Vendored subset of the pi RPC protocol (pi-coding-agent 1.0.0).
// Source of truth: docs/rpc.md, rpc-commands.md, rpc-extension-ui.md, json.md,
// message-types.md and session-format.md in the installed package. Keep this file
// types-only; pi is an external process, not a dependency.

// ── Content blocks ──────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  namespace?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface SystemMessage {
  role: "system";
  timestamp: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// ── Models & state ──────────────────────────────────────────────────────────

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RpcSessionState {
  model?: Model;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

// ── Commands (stdin) ────────────────────────────────────────────────────────

export type RpcCommand =
  | { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: ImageContent[] }
  | { type: "follow_up"; message: string; images?: ImageContent[] }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "new_session"; parentSession?: string }
  | { type: "get_state" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "get_available_models" }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "get_available_thinking_levels" }
  | { type: "compact"; customInstructions?: string }
  | { type: "abort_retry" }
  | { type: "bash"; command: string; excludeFromContext?: boolean }
  | { type: "abort_bash" }
  | { type: "get_session_stats" }
  | { type: "get_entries"; since?: string }
  | { type: "set_session_name"; name: string }
  | { type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

export interface RpcResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

// ── Session events (stdout) ─────────────────────────────────────────────────

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "done"; reason: string; message: AssistantMessage }
  | { type: "error"; reason: string; error: AssistantMessage };

export interface ToolResultLike {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}

export type SessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; usage?: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: ToolResultLike;
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultLike; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result?: { summary: string; tokensBefore: number; estimatedTokensAfter?: number };
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };

// ── Extension UI subprotocol ────────────────────────────────────────────────

export type ExtensionUiDialog =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; timeout?: number };

export type ExtensionUiNotice =
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type ExtensionUiRequest = ExtensionUiDialog | ExtensionUiNotice;

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

// ── Session file entries ────────────────────────────────────────────────────

interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type SessionEntry =
  | (EntryBase & { type: "message"; message: AgentMessage })
  | (EntryBase & { type: "model_change"; provider: string; modelId: string })
  | (EntryBase & { type: "thinking_level_change"; thinkingLevel: ThinkingLevel })
  | (EntryBase & { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number })
  | (EntryBase & { type: "branch_summary"; fromId: string; summary: string })
  | (EntryBase & {
      type: "custom_message";
      customType: string;
      content: string | (TextContent | ImageContent)[];
      display: boolean;
      details?: unknown;
    })
  | (EntryBase & { type: "session_info"; name?: string })
  | (EntryBase & { type: "custom" | "label" | "usage" | "context_edit" });

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

/** Everything pi writes to stdout in RPC mode. */
export type RpcOutput = RpcResponse | SessionEvent | ExtensionUiRequest;
