// One GPT-Live call's backend (docs/DESIGN.md, Voice calls): it keeps the call's transcript from the window's events
// and answers GPT-Live's client delegations. A delegation carries no text, so it waits until the user's words have
// stopped arriving, asks the call's brain (brain.ts) with the conversation so far, and sends the answer back as
// commentary for GPT-Live to say. GPT-Live can hand off during a pause mid-sentence ("tell the release chat to push…
// but run the tests first"): words that come within a few seconds of a hand-off go to the brain as a follow-up, so it
// can correct what it sent. Delegations are answered one at a time, in order.
import { addFragment, clipCommentary, type CallEvent, delegationPrompt, type LiveEvent, type TranscriptLine } from "../../shared/voice";

/** A delegation waits at least this long, and until no user words came for SETTLE_MS (they may still be coming). */
const SETTLE_MIN_MS = 1000;
const SETTLE_MS = 600;
/** And at most this long. */
const SETTLE_MAX_MS = 4000;
/** Words this soon after a hand-off belong to it: they go to the brain as a follow-up. */
const CONTINUE_MS = 3000;
/** The brain's answer to a follow-up that changes nothing. */
const NOTHING = "NOTHING";

export interface LiveCallDeps {
  ask(prompt: string, signal: AbortSignal): Promise<string>;
  emit(event: CallEvent): void;
  now?: () => number;
}

export class LiveCall {
  private lines: TranscriptLine[] = [];
  /** Session time up to which user words went with an earlier delegation. */
  private handled = -1;
  private lastUserWords = 0;
  private queue: Promise<void> = Promise.resolve();
  /** The hand-off being answered: when it came, and the user's words since its prompt was written. */
  private current: { id: string; at: number; asked: boolean; extra: string } | undefined;
  private readonly abort = new AbortController();
  private seq = 0;

  constructor(private readonly deps: LiveCallDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A server event from the call's data channel. */
  event(event: LiveEvent): void {
    if (this.abort.signal.aborted) return;
    const end = typeof event.end_ms === "number" ? event.end_ms : 0;
    if (event.type === "session.input_transcript.delta" && typeof event.delta === "string") {
      this.lines = addFragment(this.lines, "user", event.delta, end);
      this.lastUserWords = this.now();
      if (this.current?.asked && this.now() - this.current.at < CONTINUE_MS) this.current.extra += event.delta;
    } else if (event.type === "session.output_transcript.delta" && typeof event.delta === "string") {
      this.lines = addFragment(this.lines, "assistant", event.delta, end);
    } else if (event.type === "session.delegation.created") {
      const delegation = event.delegation as { id?: unknown; target?: unknown } | undefined;
      if (typeof delegation?.id !== "string" || (delegation.target !== undefined && delegation.target !== "client")) return;
      const id = delegation.id;
      const at = this.now();
      this.deps.emit({ type: "work", id, done: false });
      this.queue = this.queue.then(() => this.delegate(id, at));
    }
  }

  /** Waits until `from` + `min` has passed and no user words came for SETTLE_MS (at most SETTLE_MAX_MS). */
  private async settle(from: number, min: number): Promise<void> {
    const started = this.now();
    while (
      !this.abort.signal.aborted &&
      this.now() - started < SETTLE_MAX_MS &&
      (this.now() - from < min || this.now() - this.lastUserWords < SETTLE_MS)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async ask(prompt: string): Promise<string | undefined> {
    try {
      return (await this.deps.ask(prompt, this.abort.signal)).trim();
    } catch (error) {
      if (this.abort.signal.aborted) return undefined;
      this.deps.emit({ type: "error", message: (error as Error).message });
      return `That did not work: ${(error as Error).message}.`;
    }
  }

  private say(id: string, answer: string): void {
    const content = clipCommentary(answer);
    this.deps.emit({ type: "send", event: { type: "session.commentary.append", event_id: `pigna_${++this.seq}`, delegation_id: id, content } });
    this.deps.emit({ type: "work", id, done: true, text: content });
  }

  private async delegate(id: string, at: number): Promise<void> {
    await this.settle(at, SETTLE_MIN_MS);
    if (this.abort.signal.aborted) return;
    const prompt = delegationPrompt(this.lines, this.handled);
    this.handled = Math.max(this.handled, ...this.lines.map((line) => line.end));
    const current = (this.current = { id, at, asked: true, extra: "" });
    const answer = await this.ask(prompt);
    if (answer === undefined || this.abort.signal.aborted) return;
    this.say(id, answer || "Done; there is nothing to report.");
    // Words that came after the prompt was written, still about this hand-off: the brain may need to correct itself.
    await this.settle(at, CONTINUE_MS);
    this.current = undefined;
    const extra = current.extra.trim();
    if (!extra || this.abort.signal.aborted) return;
    this.handled = Math.max(this.handled, ...this.lines.map((line) => line.end));
    const followUp = await this.ask(
      `The user went on talking after the hand-off you just answered, and said: ${extra}\nIf this changes or adds to what they asked, act on it now (for a chat you already told something, send it the correction or the missing part with thread_send) and say what you did. If it changes nothing, reply with exactly ${NOTHING}.`,
    );
    if (followUp === undefined || this.abort.signal.aborted || !followUp || followUp.replace(/[^A-Z]/g, "") === NOTHING) return;
    this.say(id, followUp);
  }

  /** Waits for the delegations already in the queue (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  end(): void {
    this.abort.abort();
  }
}
