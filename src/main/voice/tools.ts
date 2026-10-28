// The voice assistant's tools (docs/DESIGN.md, Voice calls): list the project's chats, read one's last turn, send one
// what the user asked. They share the threads tools' sources (src/main/threads.ts) but answer in the small, plain
// shape a 2B model handles: a list of numbered chats with title and status, one turn clipped short, and errors it can
// recover from. Chats are numbered, not given their session ids: ids that differ in a few hex digits got mixed up.
import { projectOf } from "../../shared/board";
import type { SessionSummary } from "../../shared/ipc";
import { resolveThread, status, type ThreadSources, toTurns } from "../threads";

/** Tool definitions as /v1/realtime takes them (session.update `tools`). */
export const VOICE_TOOLS = [
  {
    type: "function",
    name: "threads_list",
    description: "List the user's chats in this project: id, title, and whether each is running, waiting for the user, failed or idle.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "thread_read",
    description: "Read a chat's latest turn: what the user asked it and what its agent did and answered.",
    parameters: { type: "object", properties: { thread: { type: "string", description: "Chat id from threads_list" } }, required: ["thread"] },
  },
  {
    type: "function",
    name: "thread_send",
    description: "Send a request to one chat's coding agent. message: what the user asked, close to their own words.",
    parameters: {
      type: "object",
      properties: { thread: { type: "string", description: "Chat id from threads_list" }, message: { type: "string" } },
      required: ["thread", "message"],
    },
  },
] as const;

/** What the voice assistant is told: it acts with the tools and is heard, not read. */
export const VOICE_INSTRUCTIONS =
  "You are the voice of pi-gna, an app where the user runs coding agents in chats. You hear the user and act for them with tools: " +
  "send their requests to the right chat with thread_send, and read chats to answer their questions. Call threads_list to find a chat's id. " +
  "Your text is spoken aloud: answer in one or two short sentences, no markdown, no ids.";

/** How many chats a list shows, and how much of a turn a read keeps. */
const LIST = 12;
const PROMPT_CHARS = 300;
const REPLY_CHARS = 1200;

export interface ToolResult {
  /** What goes back to the model (function_call_output). */
  output: string;
  /** What the call screen shows, when the tool did something worth seeing. */
  action?: string;
}

export type VoiceSources = Pick<ThreadSources, "sessions" | "live" | "read" | "deliver">;

/** A message the voice assistant relays: the user said it, but a small model heard and worded it. */
export function voiceMessage(text: string): string {
  return `[Voice call: the user said this aloud to pi-gna's voice assistant, which relayed it; a word may be misheard or paraphrased.]\n\n${text.trim()}`;
}

export class VoiceTools {
  /** The numbers the last list gave, to the chat's session file. */
  private readonly numbers = new Map<string, string>();

  constructor(
    private readonly sources: VoiceSources,
    /** The project the call is in: its chats are the ones the tools see. */
    private readonly project: string,
  ) {}

  private async chats(): Promise<SessionSummary[]> {
    return (await this.sources.sessions()).flatMap((group) => group.sessions).filter((session) => projectOf(session.cwd) === this.project);
  }

  /** A chat by its number in the last list, the end of its session id, or its title. */
  private find(chats: SessionSummary[], id: unknown): SessionSummary | string {
    const wanted = String(id ?? "").trim();
    const numbered = this.numbers.get(wanted.replace(/^#/, ""));
    const byNumber = numbered && chats.find((chat) => chat.path === numbered);
    if (byNumber) return byNumber;
    try {
      return resolveThread(chats, wanted);
    } catch {
      const name = wanted.toLowerCase();
      const titled = name.length >= 3 ? chats.filter((chat) => chat.title.toLowerCase().includes(name) || name.includes(chat.title.toLowerCase())) : [];
      if (titled.length === 1) return titled[0]!;
      return `There is no chat ${wanted}. Call threads_list for the chat ids.`;
    }
  }

  /** Runs one tool call; a failure is an output the model can read and recover from, never a throw. */
  async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case "threads_list":
          return await this.list();
        case "thread_read":
          return await this.read(args.thread);
        case "thread_send":
          return await this.send(args.thread, args.message);
        default:
          return { output: `There is no tool ${name}.` };
      }
    } catch (error) {
      return { output: `That failed: ${(error as Error).message}` };
    }
  }

  private async list(): Promise<ToolResult> {
    const live = new Map(this.sources.live().flatMap((chat) => (chat.sessionPath ? [[chat.sessionPath, chat] as const] : [])));
    const chats = (await this.chats()).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, LIST);
    this.numbers.clear();
    const rows = chats.map((chat, index) => {
      const state = live.get(chat.path);
      const said = state?.attention === "waiting" ? "waiting for the user" : state?.running ? "running" : state?.attention === "failed" ? "failed" : "idle";
      this.numbers.set(String(index + 1), chat.path);
      return { id: String(index + 1), title: chat.title, status: said };
    });
    return { output: rows.length ? JSON.stringify(rows) : "This project has no chats yet.", action: "Looked at the chats" };
  }

  private async read(id: unknown): Promise<ToolResult> {
    const thread = this.find(await this.chats(), id);
    if (typeof thread === "string") return { output: thread };
    const turn = toTurns(await this.sources.read(thread.path)).at(-1);
    const live = this.sources.live().find((chat) => chat.sessionPath === thread.path);
    const head = `Chat ${thread.title} (${status(live) || "closed"}).`;
    if (!turn) return { output: `${head} It has no turns yet.`, action: `Read ${thread.title}` };
    const prompt = turn.lines[0]?.slice(0, PROMPT_CHARS) ?? "";
    const reply = turn.lines.findLast((line) => line.startsWith("Assistant: "))?.slice(0, REPLY_CHARS) ?? "Assistant: (no reply yet)";
    return { output: `${head}\n${prompt}\n${reply}`, action: `Read ${thread.title}` };
  }

  private async send(id: unknown, message: unknown): Promise<ToolResult> {
    const text = String(message ?? "").trim();
    if (!text) return { output: "Pass message: what to tell the chat." };
    const thread = this.find(await this.chats(), id);
    if (typeof thread === "string") return { output: thread };
    // A chat at work hears it after its current tool call: in a call you talk to it now, not after its run.
    const outcome = await this.sources.deliver(thread, voiceMessage(text), "steer");
    const how = { started: "it started working on it", steer: "it is running and reads it after its current step", followUp: "it reads it when its run ends", opening: "it is opening and will start on it" }[outcome];
    return { output: `Sent to ${thread.title}: ${how}.`, action: `Sent to ${thread.title}: “${text}”` };
  }
}
