// Voice calls (Settings > Agent > Beta, off by default): talk to pi-gna about the project's chats. OpenAI's GPT-Live
// (gpt-live-1) holds the spoken conversation in the window over WebRTC: it listens while it speaks, takes turns and
// can be interrupted. What needs the chats it hands to pi-gna (client delegation), and a "Voice call" pi chat on the
// voice task's model (gpt-6.1-terra by default, on the user's subscription) answers or passes requests on
// (src/main/voice). The API key is the user's, in the macOS Keychain. Everything here is pure, for both sides and the
// tests.

/** Whether calls can start: off, ready, or what is missing (no API key). */
export interface VoiceStatus {
  phase: "off" | "ready" | "error";
  error?: string;
}

/** The Keychain item that holds the OpenAI API key (generic password, account = the user's login name). */
export const KEYCHAIN_SERVICE = "pi-gna.openai-api-key";

/** How to store the key: a hidden prompt, passed on stdin so it is neither cut at 128 characters nor in `ps`. */
export const KEY_COMMAND = `read -rs "K?OpenAI API key: " && echo && printf 'add-generic-password -U -s ${KEYCHAIN_SERVICE} -a %s -T /usr/bin/security -w %s\\n' "$USER" "$K" | /usr/bin/security -i && echo "stored \${#K} chars"; unset K`;

/** What the call screen shows the call doing. */
export type CallState = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended";

/** One GPT-Live server event, as the window's data channel received it. */
export type LiveEvent = { type: string; [key: string]: unknown };

/** What main tells the window about a call. */
export type CallEvent =
  /** Send this command on the call's data channel. */
  | { type: "send"; event: LiveEvent }
  /** The chats were asked something; `done` once the answer went back to GPT-Live. */
  | { type: "work"; id: string; done: boolean; text?: string }
  | { type: "error"; message: string };

/** One speaker's run of words in the call's transcript. */
export interface TranscriptLine {
  speaker: "user" | "assistant";
  text: string;
  /** Session time (ms) of its last fragment. */
  end: number;
}

/**
 * The transcript with one more fragment: a fragment of the speaker of the last line joins it, another speaker starts
 * a line. GPT-Live sends fragments with their spacing; they are joined exactly as received.
 */
export function addFragment(lines: readonly TranscriptLine[], speaker: TranscriptLine["speaker"], delta: string, end: number): TranscriptLine[] {
  const last = lines.at(-1);
  if (last?.speaker === speaker) return [...lines.slice(0, -1), { speaker, text: last.text + delta, end: Math.max(last.end, end) }];
  return [...lines, { speaker, text: delta, end }];
}

/** How much of the conversation goes to the chat with a handed-off request. */
const CONTEXT_LINES = 12;
const CONTEXT_CHARS = 3000;

/**
 * What the Voice call chat is told about a handed-off request: the conversation so far, newest last, and what the
 * user said since the last request (which may be nothing new, when GPT-Live hands off on its own).
 */
export function delegationPrompt(lines: readonly TranscriptLine[], since: number): string {
  const said = lines.filter((line) => line.speaker === "user" && line.end > since).map((line) => line.text.trim()).filter(Boolean).join(" ");
  const recent: string[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    const text = `${line.speaker === "user" ? "User" : "Voice assistant"}: ${line.text.trim()}`;
    if (recent.length >= CONTEXT_LINES || size + text.length > CONTEXT_CHARS) break;
    recent.unshift(text);
    size += text.length;
  }
  return `The call so far (a speech transcript, a word may be misheard):\n${recent.join("\n") || "(nothing yet)"}\n\nThe voice assistant handed this to you. What the user said since the last hand-off: ${said || "(nothing new; answer from the call so far)"}`;
}

/** GPT-Live takes at most 500 tokens of context per append; this keeps well under it. */
export const COMMENTARY_CHARS = 1200;

export function clipCommentary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > COMMENTARY_CHARS ? `${flat.slice(0, COMMENTARY_CHARS - 1).trimEnd()}…` : flat;
}
