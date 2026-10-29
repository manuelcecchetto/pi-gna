// The voice call's brain (docs/DESIGN.md, Voice calls): a pi chat named "Voice call" in the call's project, on the
// voice task's model (gpt-6.1-terra by default). Each request GPT-Live hands off goes to it as a prompt with a fresh
// snapshot of the project's chats, so it can answer or route without first listing and reading them; it keeps
// pi-gna's threads tools for more, and thread_send to pass requests on. Its last reply goes back to GPT-Live to say.
import { randomUUID } from "node:crypto";
import { projectOf } from "../../shared/board";
import type { AttentionSummary } from "../../shared/host-api";
import type { ProjectGroup, SessionSummary } from "../../shared/ipc";
import type { RpcSessionState, SessionEntry } from "../../shared/protocol";
import type { Item, RunOutcome } from "../../shared/session-state";
import type { TaskModel } from "../../shared/settings";
import type { SessionHost } from "../session-host";
import { shortId, toTurns } from "../threads";

/** How many chats the snapshot names, how many of the newest carry their last reply, and how much of it. */
const CHATS = 15;
const WITH_REPLY = 6;
const REPLY_CHARS = 280;
const READ_MS = 1500;
const RUN_MS = 180_000;

export const VOICE_BRIEF = `This chat is the backend of pi-gna's voice calls. The user talks with a voice assistant (OpenAI's GPT-Live); when the user asks about their chats (threads) of this project, or asks to tell one something, the voice assistant hands it to you. Each message gives the chats as they are now, the call so far as a speech transcript (a word may be misheard), and what the user said since the last hand-off.

- When the user asks a chat to do something, send it one clear, self-contained prompt with thread_send. Start it with "The user asked by voice:", keep every detail and condition they gave, add nothing they did not ask for, in English. Use mode steer when the chat is running and the user wants it to change course now.
- When they ask about their chats, answer from the snapshot; use thread_read only when it does not say enough.
- Never call thread_send for a greeting, small talk, thanks, thinking aloud, a request they take back, or when you are not sure which chat or what to send: say what is unclear instead, and the voice assistant will ask. If two chats could fit, name both.
- Do no work yourself: no commands, no reading or editing files, no other tools. The chats do the work.

Your reply goes to the voice assistant, which says it in its own words: one to three short sentences of plain facts (what you found, what you sent to which chat), no markdown, no ids, no lists.`;

export interface BrainDeps {
  host: Pick<SessionHost, "open" | "command" | "release" | "stateOf" | "onSettled" | "onExit">;
  sessions: () => Promise<ProjectGroup[]>;
  live: () => AttentionSummary[];
  read: (path: string) => Promise<SessionEntry[]>;
  model: () => Promise<TaskModel>;
  useModel: (handle: string, model: TaskModel) => Promise<void>;
}

/** What the brain is told with each turn: the project's chats right now, newest first. */
export async function snapshot(deps: Pick<BrainDeps, "sessions" | "live" | "read">, project: string, self?: string): Promise<string> {
  const live = new Map(deps.live().flatMap((chat) => (chat.sessionPath ? [[chat.sessionPath, chat] as const] : [])));
  const chats = (await deps.sessions())
    .flatMap((group) => group.sessions)
    .filter((chat) => projectOf(chat.cwd) === project && chat.path !== self)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, CHATS);
  if (!chats.length) return "Chats now: none in this project.";
  const replies = await Promise.all(chats.map((chat, index) => (index < WITH_REPLY ? lastReply(deps, chat) : Promise.resolve(undefined))));
  const lines = chats.map((chat, index) => {
    const state = live.get(chat.path);
    const status = state?.attention === "waiting" ? "waiting for the user" : state?.running ? "running" : state?.attention === "failed" ? "last run failed" : "idle";
    const reply = replies[index];
    return `- ${shortId(chat)} ${chat.title} (${status})${reply ? `\n  last reply: ${reply}` : ""}`;
  });
  return `Chats now, newest first (id, title, status):\n${lines.join("\n")}`;
}

async function lastReply(deps: Pick<BrainDeps, "read">, chat: SessionSummary): Promise<string | undefined> {
  const entries = await Promise.race([deps.read(chat.path).catch(() => []), new Promise<SessionEntry[]>((resolve) => setTimeout(() => resolve([]), READ_MS))]);
  const line = toTurns(entries)
    .at(-1)
    ?.lines.findLast((text) => text.startsWith("Assistant: "));
  const text = line?.slice("Assistant: ".length).replace(/\s+/g, " ").trim();
  return text && text.length > REPLY_CHARS ? `${text.slice(0, REPLY_CHARS - 1)}…` : text;
}

/** The text of the last assistant message among `items` from `from` on. */
export function replyText(items: readonly Item[], from: number): string {
  for (let index = items.length - 1; index >= from; index--) {
    const item = items[index];
    if (item?.kind !== "assistant") continue;
    const text = item.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ").trim();
    if (text) return text;
  }
  return "";
}

/** One call's brain: opens its chat on the first turn and lets it go when the call ends. */
export class VoiceBrain {
  private handle: Promise<string> | undefined;
  private path: string | undefined;
  private readonly hold = `voice:${randomUUID()}`;
  private first = true;

  constructor(
    private readonly deps: BrainDeps,
    private readonly cwd: string,
  ) {}

  private open(): Promise<string> {
    this.handle ??= (async () => {
      const { host } = this.deps;
      const { handle } = await host.open({ cwd: this.cwd }, { hold: this.hold });
      const state = await host.command(handle, { type: "get_state" });
      if (!state.success) throw new Error(state.error ?? "pi did not start");
      this.path = (state.data as RpcSessionState | undefined)?.sessionFile;
      await this.deps.useModel(handle, await this.deps.model());
      await host.command(handle, { type: "set_session_name", name: "Voice call" });
      return handle;
    })().catch((error: Error) => {
      this.handle = undefined;
      throw error;
    });
    return this.handle;
  }

  /** Opens the chat ahead of the first turn, so pi is up by the time the user stops talking. */
  warm(): void {
    void this.open().catch(() => undefined);
  }

  /** The answer to `request` (the call so far and what the user said, delegationPrompt); `signal` stops the chat's run. */
  async ask(request: string, signal: AbortSignal): Promise<string> {
    const { host } = this.deps;
    const [handle, chats] = await Promise.all([this.open(), snapshot(this.deps, projectOf(this.cwd), this.path)]);
    if (signal.aborted) throw new Error("stopped");
    // A chat it told something may answer it (thread_send), which starts a run here: the user's turn waits for it.
    if (host.stateOf(handle)?.running) await this.idle(handle, signal);
    const message = `${this.first ? `${VOICE_BRIEF}\n\n` : ""}${chats}\n\n${request}`;
    this.first = false;
    const from = host.stateOf(handle)?.items.length ?? 0;
    let off: (() => void)[] = [];
    const settled = new Promise<RunOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the voice chat took too long")), RUN_MS);
      off = [
        host.onSettled((settledHandle, outcome) => settledHandle === handle && resolve(outcome)),
        host.onExit((exited) => exited === handle && reject(new Error("the voice chat stopped"))),
        () => clearTimeout(timer),
      ];
      signal.addEventListener("abort", () => {
        void host.command(handle, { type: "abort" });
        reject(new Error("stopped"));
      });
    });
    try {
      const sent = await host.command(handle, { type: "prompt", message });
      if (!sent.success) throw new Error(sent.error ?? "the voice chat did not take the message");
      const outcome = await settled;
      const reply = replyText(host.stateOf(handle)?.items ?? [], from);
      if (outcome === "error" && !reply) throw new Error("the voice chat's model failed");
      return reply;
    } finally {
      for (const stop of off) stop();
    }
  }

  /** Resolves once the chat's run going on settles (or after a minute, or on Stop). */
  private idle(handle: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        off();
        clearTimeout(timer);
        resolve();
      };
      const off = this.deps.host.onSettled((settled) => settled === handle && done());
      const timer = setTimeout(done, 60_000);
      signal.addEventListener("abort", () => {
        off();
        clearTimeout(timer);
        reject(new Error("stopped"));
      });
    });
  }

  /** The call ended: the chat stays in the sidebar and closes once nobody looks at it. */
  end(): void {
    void this.handle?.then((handle) => this.deps.host.release(handle, this.hold)).catch(() => undefined);
  }
}
