// Voice calls' main side (docs/DESIGN.md, Voice calls). The window connects to GPT-Live over WebRTC; main holds the
// OpenAI API key (macOS Keychain, else OPENAI_API_KEY), creates the session from the window's SDP offer, and answers
// the call's client delegations with its brain (brain.ts, a "Voice call" pi chat) through LiveCall. One call at a time.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { type CallEvent, KEYCHAIN_SERVICE, type LiveEvent, type VoiceStatus } from "../../shared/voice";
import { log } from "../log";
import type { VoiceBrain } from "./brain";
import { LiveCall } from "./live";

const SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const CREATE_MS = 20_000;

/** GPT-Live's own prompt: how to talk, and when to hand off. The detail is the brain's (VOICE_BRIEF). */
export const LIVE_INSTRUCTIONS = [
  "You are the voice of pi-gna, an app where the user runs AI coding agents in chats (threads). You talk with the user on a call.",
  "You cannot see or change the chats yourself. Hand off to your backend every question about the user's chats or their work, and every request to tell, ask or send a chat something; then say the backend's answer in your own words, briefly. Say only what the backend's answer says was done; never claim a chat was told something the answer does not mention.",
  "Answer greetings, small talk and questions about the conversation itself directly, without handing off. If you are not sure what the user wants from a chat, ask before handing off.",
  "Answer in the language of the user's latest full sentence; a one-word greeting such as \"ciao\" does not choose the language. Keep turns short: one or two sentences. Let the user finish; if they pause mid-thought, wait.",
].join("\n");

export interface VoiceDeps {
  /** The OpenAI API key, or undefined when none is stored. */
  key(): Promise<string | undefined>;
  fetch: typeof fetch;
  /** The call's brain: a pi chat in `cwd`'s project. */
  brain(cwd: string): Pick<VoiceBrain, "warm" | "ask" | "end">;
  onStatus(status: VoiceStatus): void;
  /** A call's events, for the window that started it. */
  onEvent(id: string, event: CallEvent): void;
}

/** The key from the login Keychain (macOS), else the environment. */
export function readKey(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(process.env.OPENAI_API_KEY || undefined);
  return new Promise((resolve) =>
    execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", userInfo().username, "-w"], (error, stdout) =>
      resolve(error ? process.env.OPENAI_API_KEY || undefined : stdout.trim() || undefined),
    ),
  );
}

export class Voice {
  private status: VoiceStatus = { phase: "off" };
  private enabled = false;
  private call: { id: string; live: LiveCall; brain: Pick<VoiceBrain, "end"> } | undefined;

  constructor(private readonly deps: VoiceDeps) {}

  get(): VoiceStatus {
    return this.status;
  }

  private set(status: VoiceStatus): void {
    this.status = status;
    this.deps.onStatus(status);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) void this.check();
    else {
      this.endCall();
      this.set({ phase: "off" });
    }
  }

  /** Looks for the key again (Settings' Retry, after storing it). */
  retry(): void {
    if (this.enabled) void this.check();
  }

  private async check(): Promise<void> {
    const key = await this.deps.key();
    if (!this.enabled) return;
    this.set(key ? { phase: "ready" } : { phase: "error", error: "No OpenAI API key yet." });
  }

  /**
   * Starts the call `id` about `cwd`'s project from the window's WebRTC offer, ending one going on, and returns the
   * SDP answer. GPT-Live's events come back through `event`.
   */
  async startCall(id: string, cwd: string, sdp: string): Promise<string> {
    if (!this.enabled) throw new Error("Voice calls are off.");
    const key = await this.deps.key();
    if (!key) {
      this.set({ phase: "error", error: "No OpenAI API key yet." });
      throw new Error("No OpenAI API key yet: store one first (Settings > Agent > Voice calls).");
    }
    this.endCall();
    const brain = this.deps.brain(cwd);
    // pi starts while the call connects and the user says the first thing.
    brain.warm();
    const live = new LiveCall({ ask: (prompt, signal) => brain.ask(prompt, signal), emit: (event) => this.deps.onEvent(id, event) });
    this.call = { id, live, brain };
    try {
      const response = await this.deps.fetch(SESSIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          session: { model: "gpt-live-1", instructions: LIVE_INSTRUCTIONS, audio: { output: { voice: "marin" } }, delegation: { type: "client" } },
          transport: { type: "webrtc", sdp },
        }),
        signal: AbortSignal.timeout(CREATE_MS),
      });
      const body = (await response.json().catch(() => ({}))) as { transport?: { sdp?: unknown }; error?: { message?: unknown } };
      if (!response.ok || typeof body.transport?.sdp !== "string") {
        const message = typeof body.error?.message === "string" ? body.error.message : `OpenAI answered ${response.status}`;
        log.warn("voice", `session create failed: ${response.status} ${message}`);
        throw new Error(response.status === 401 ? "OpenAI refused the API key (401). Store it again." : message);
      }
      return body.transport.sdp;
    } catch (error) {
      this.endCall(id);
      throw error;
    }
  }

  /** A server event the window's data channel received. */
  event(id: string, event: LiveEvent): void {
    if (this.call?.id !== id) return;
    this.call.live.event(event);
    if (event.type === "session.closed") this.endCall(id);
  }

  endCall(id?: string): void {
    if (!this.call || (id !== undefined && this.call.id !== id)) return;
    this.call.live.end();
    this.call.brain.end();
    this.call = undefined;
  }

  dispose(): void {
    this.enabled = false;
    this.endCall();
  }
}
