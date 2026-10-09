// POST /threads on the agent bridge: the threads_list, thread_read and thread_send tools. The calling chat is the
// session behind the token. A list shows the chats of its project (projectOf: a card's worktree counts as its
// project), or of every project; a read shows a thread's newest turns from its session file, user prompts and replies
// in full and tool calls as one line each. A send hands a thread of the same project a message, labelled with the
// sender (threadMessageBlock), and returns without waiting for an answer.
import { projectOf } from "../shared/board";
import type { AttentionSummary } from "../shared/host-api";
import type { ProjectGroup, SessionSummary } from "../shared/ipc";
import type { AgentMessage, SessionEntry } from "../shared/protocol";
import { THREAD_LIMITS, type ThreadSendMode, threadMessageBlock, type ThreadsRequest, type ThreadsResponse } from "../shared/threads";
import { bridgeError, type Route } from "./bridge";
import type { Identify } from "./kanban";

export interface ThreadSources {
  identify: Identify;
  /** The sidebar's listing of pi's sessions folder. */
  sessions: () => Promise<ProjectGroup[]>;
  /** The chats open in pi-gna right now, with their run state. */
  live: () => AttentionSummary[];
  /** A session file's active branch, root to leaf. */
  read: (path: string) => Promise<SessionEntry[]>;
  /** Give a thread a prompt: at once when it is open, else once pi-gna has opened it (not waited for). */
  deliver: (thread: { path: string; cwd: string }, message: string, mode: ThreadSendMode) => Promise<Delivery>;
}

/** What became of a sent message: a run started, it waits in the running thread's queue, or the thread is opening. */
export type Delivery = "started" | "steer" | "followUp" | "opening";

/**
 * How long a thread id the tools print: the end of the session id, since pi's are UUIDv7, whose start is a timestamp
 * (chats started the same minute share it). Any unique end of 4 or more characters works, or the whole id.
 */
const SHORT_ID = 8;
/** An earlier reply in a turn (the agent narrating between tool calls), and a turn's last reply or a prompt. */
const STEP_CHARS = 600;
const MESSAGE_CHARS = 6000;
const ARGS_CHARS = 120;
/** Tool calls kept at each end of a longer run of them. */
const CALLS_SHOWN = 3;

export function threadsRoute(sources: ThreadSources): Route {
  return async (handle, body): Promise<ThreadsResponse> => {
    const request = body as ThreadsRequest;
    const chat = await sources.identify(handle);
    const sessions = (await sources.sessions()).flatMap((group) => group.sessions);
    const live = new Map(sources.live().flatMap((summary) => (summary.sessionPath ? [[summary.sessionPath, summary] as const] : [])));
    switch (request?.action) {
      case "list":
        return { text: list(sessions, live, chat, request) };
      case "read": {
        const thread = resolve(sessions, String(request.thread ?? ""));
        return { text: read(thread, await sources.read(thread.path), live.get(thread.path), chat.path, request) };
      }
      case "send":
        return { text: await send(sessions, chat, request, sources.deliver) };
      default:
        throw bridgeError(400, `unknown action ${String((request as { action?: unknown })?.action)}`);
    }
  };
}

function list(sessions: SessionSummary[], live: Map<string, AttentionSummary>, chat: { path: string; cwd: string }, request: Extract<ThreadsRequest, { action: "list" }>): string {
  const project = projectOf(chat.cwd);
  const query = request.query?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, Math.floor(request.limit ?? THREAD_LIMITS.list)), THREAD_LIMITS.listMax);
  const matching = sessions
    .filter((session) => request.all || projectOf(session.cwd) === project)
    .filter((session) => !query || session.title.toLowerCase().includes(query))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const scope = request.all ? "every project" : project;
  const filter = query ? ` matching "${request.query!.trim()}"` : "";
  const head = `Threads of ${scope}${filter}: ${matching.length}, newest first.${matching.length > limit ? ` Showing ${limit} (pass limit for more).` : ""} Read one with thread_read and its id.`;
  if (!matching.length) return `${head}${request.all ? "" : " Pass all to list every project's threads."}`;
  const lines = matching.slice(0, limit).map((session) => {
    const marks = [status(live.get(session.path)), session.path === chat.path ? "this chat" : ""].filter(Boolean);
    const where = request.all ? projectOf(session.cwd) : session.cwd !== project ? session.cwd : "";
    return `- ${shortId(session)} ${session.title}  (${[...marks, `updated ${stamp(session.modifiedAt)}`].join(", ")})${where ? `\n  in ${where}` : ""}`;
  });
  return [head, ...lines].join("\n");
}

async function send(sessions: SessionSummary[], chat: { path: string; cwd: string }, request: Extract<ThreadsRequest, { action: "send" }>, deliver: ThreadSources["deliver"]): Promise<string> {
  const message = String(request.message ?? "").trim();
  if (!message) throw bridgeError(400, "pass message: what to tell the thread");
  if (message.length > THREAD_LIMITS.message) throw bridgeError(400, `message is ${message.length} characters; at most ${THREAD_LIMITS.message}`);
  if (request.mode !== undefined && request.mode !== "steer" && request.mode !== "followUp") throw bridgeError(400, "mode is steer or followUp");
  const project = projectOf(chat.cwd);
  const thread = resolve(sessions, String(request.thread ?? ""));
  if (projectOf(thread.cwd) !== project) throw bridgeError(403, `Thread ${shortId(thread)} is in ${projectOf(thread.cwd)}; thread_send reaches this project's threads only.`);
  if (thread.path === chat.path) throw bridgeError(400, "That is this chat; pass another thread's id.");
  const self = sessions.find((session) => session.path === chat.path);
  const from = { id: self ? shortId(self) : chat.path.replace(/\.jsonl$/, "").slice(-SHORT_ID), title: self?.title ?? "Untitled chat" };
  const outcome = await deliver(thread, threadMessageBlock(from, message), request.mode ?? "followUp");
  const to = `thread ${shortId(thread)} (${thread.title})`;
  const what = {
    started: `Sent to ${to}: it was idle and started a run on it.`,
    steer: `Sent to ${to}: it is running and gets the message after its current tool call.`,
    followUp: `Sent to ${to}: it is running and gets the message when its run ends.`,
    opening: `Sent to ${to}: it was closed, so pi-gna is opening it and will start a run on the message.`,
  }[outcome];
  return `${what} It knows the message is from thread ${from.id}. This does not wait for an answer: check later with thread_read.`;
}

/** A thread by id: its whole session id or a unique end of it. */
function resolve(sessions: SessionSummary[], id: string): SessionSummary {
  const wanted = id.trim().toLowerCase();
  if (wanted.length < 4) throw bridgeError(400, "pass thread: an id from threads_list (at least 4 characters)");
  const found = sessions.filter((session) => session.id.toLowerCase().endsWith(wanted));
  if (found.length === 1) return found[0]!;
  if (!found.length) throw bridgeError(404, `No thread ${id}. Use threads_list (with all for every project) to see the threads.`);
  throw bridgeError(409, `Thread id ${id} is ambiguous: ${found.map((session) => `${session.id} ${session.title}`).join("; ")}. Pass more of it.`);
}

interface Turn {
  at: string;
  lines: string[];
}

function read(thread: SessionSummary, entries: SessionEntry[], live: AttentionSummary | undefined, self: string, request: Extract<ThreadsRequest, { action: "read" }>): string {
  const turns = toTurns(entries);
  const total = turns.length;
  const count = Math.min(Math.max(1, Math.floor(request.turns ?? THREAD_LIMITS.turns)), THREAD_LIMITS.turnsMax);
  const end = Math.min(Math.max(1, Math.floor(request.before ?? total + 1)), total + 1) - 1;
  let start = Math.max(0, end - count);
  // Past the budget, the page keeps its newest turns (always one).
  let size = 0;
  for (let index = end - 1; index >= start; index--) {
    size += turns[index]!.lines.join("\n").length;
    if (size > THREAD_LIMITS.readChars && index < end - 1) {
      start = index + 1;
      break;
    }
  }
  const marks = [status(live), thread.path === self ? "this chat" : "", `updated ${stamp(thread.modifiedAt)}`].filter(Boolean);
  const head = [
    `Thread ${shortId(thread)}: ${thread.title}  (${marks.join(", ")})`,
    `Project ${projectOf(thread.cwd)}${thread.cwd !== projectOf(thread.cwd) ? `, worktree ${thread.cwd}` : ""}. Session file ${thread.path}`,
    total ? `Turns ${start + 1}-${end} of ${total}.${start > 0 ? ` Earlier: thread_read with before ${start + 1}.` : ""}` : "No turns yet.",
  ];
  const body = turns.slice(start, end).map((turn, index) => [`## Turn ${start + index + 1} · ${turn.at}`, ...turn.lines].join("\n"));
  return [head.join("\n"), ...body].join("\n\n");
}

/** The branch as turns: each starts at a user prompt; what comes before the first prompt is turn-less and dropped. */
function toTurns(entries: SessionEntry[]): Turn[] {
  const turns: Turn[] = [];
  const failed = new Set(entries.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError ? [entry.message.toolCallId] : [])));
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "user") {
      turns.push({ at: entry.timestamp.slice(0, 16).replace("T", " ") + "Z", lines: [`User: ${clip(contentText(message.content), MESSAGE_CHARS)}`] });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (message) turn.lines.push(...messageLines(message, failed));
    else if (entry.type === "compaction") turn.lines.push(`[Context compacted: ${clip(entry.summary, STEP_CHARS)}]`);
    else if (entry.type === "branch_summary") turn.lines.push(`[Branch summary: ${clip(entry.summary, STEP_CHARS)}]`);
    else if (entry.type === "custom_message" && entry.display) turn.lines.push(`[${entry.customType}: ${clip(contentText(entry.content), STEP_CHARS)}]`);
  }
  // A turn's last reply is the answer: it keeps more than the narration before it.
  for (const turn of turns) {
    const last = turn.lines.findLastIndex((line) => line.startsWith("Assistant: "));
    turn.lines = collapseCalls(turn.lines.map((line, index) => (line.startsWith("Assistant: ") ? clip(line, index === last ? MESSAGE_CHARS : STEP_CHARS) : line)));
  }
  return turns;
}

/** A long run of tool calls keeps its first and last few: the reader wants the replies, not a log of every grep. */
function collapseCalls(lines: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    out.push(...(run.length > CALLS_SHOWN * 2 + 1 ? [...run.slice(0, CALLS_SHOWN), `… ${run.length - CALLS_SHOWN * 2} more tool calls`, ...run.slice(-CALLS_SHOWN)] : run));
    run = [];
  };
  for (const line of lines) {
    if (line.startsWith("→ ")) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

function messageLines(message: AgentMessage, failed: Set<string>): string[] {
  switch (message.role) {
    case "assistant": {
      const lines: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) lines.push(`Assistant: ${block.text.trim()}`);
        else if (block.type === "toolCall") lines.push(`→ ${block.name}(${clip(JSON.stringify(block.arguments ?? {}), ARGS_CHARS)})${failed.has(block.id) ? " failed" : ""}`);
      }
      if (message.stopReason === "error" && message.errorMessage) lines.push(`[Error: ${clip(message.errorMessage, STEP_CHARS)}]`);
      if (message.stopReason === "aborted") lines.push("[Stopped by the user]");
      return lines;
    }
    case "bashExecution":
      return [`User ran: $ ${clip(message.command, ARGS_CHARS)} (exit ${message.exitCode ?? "?"})`];
    case "compactionSummary":
      return [`[Context compacted: ${clip(message.summary, STEP_CHARS)}]`];
    case "branchSummary":
      return [`[Branch summary: ${clip(message.summary, STEP_CHARS)}]`];
    default:
      return [];
  }
}

function contentText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content.trim();
  return content.map((block) => (block.type === "text" ? block.text ?? "" : block.type === "image" ? "[image]" : "")).filter(Boolean).join("\n").trim();
}

function status(live: AttentionSummary | undefined): string {
  if (!live) return "";
  if (live.attention === "waiting") return "open, waiting for the user";
  if (live.running) return "open, running";
  if (live.attention === "failed") return "open, last run failed";
  return "open";
}

const shortId = (session: SessionSummary) => session.id.slice(-SHORT_ID);
const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}… [${text.length - max + 1} more characters]` : text);
