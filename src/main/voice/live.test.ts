import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallEvent } from "../../shared/voice";
import { LiveCall } from "./live";
import { LIVE_INSTRUCTIONS, Voice, type VoiceDeps } from "./index";

const words = (call: LiveCall, speaker: "user" | "assistant", delta: string, end: number) =>
  call.event({ type: speaker === "user" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta, start_ms: end - 200, end_ms: end });
const delegation = (call: LiveCall, id: string) => call.event({ type: "session.delegation.created", offset_ms: 0, delegation: { id, type: "delegation", target: "client" } });

function setup(answer: (prompt: string) => Promise<string> = async () => "Sent to Release v0.29.2: tests first, then push.") {
  const events: CallEvent[] = [];
  const ask = vi.fn(answer);
  const call = new LiveCall({ ask: (prompt) => ask(prompt), emit: (event) => events.push(event) });
  /** Lets the hand-offs in the queue run to the end, waits included. */
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    await call.idle();
  };
  return { call, events, ask, settle, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}

describe("LiveCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("answers a hand-off with what the user said, as commentary for that delegation", async () => {
    const { call, events, ask, advance, settle } = setup();
    words(call, "user", " Tell the release chat to push,", 3000);
    words(call, "user", " but run the tests first.", 4000);
    await advance(1000);
    delegation(call, "item_1");
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatch(/since the last hand-off: Tell the release chat to push, but run the tests first\.$/);
    expect(events).toEqual([
      { type: "work", id: "item_1", done: false },
      { type: "send", event: { type: "session.commentary.append", event_id: "pigna_1", delegation_id: "item_1", content: "Sent to Release v0.29.2: tests first, then push." } },
      { type: "work", id: "item_1", done: true, text: "Sent to Release v0.29.2: tests first, then push." },
    ]);
  });

  it("waits for words still arriving before it asks", async () => {
    vi.useFakeTimers();
    try {
      const ask = vi.fn(async (_prompt: string) => "ok");
      vi.setSystemTime(0);
      // The real clock: words keep coming for a while after the hand-off.
      const live = new LiveCall({ ask: (prompt) => ask(prompt), emit: () => undefined });
      live.event({ type: "session.input_transcript.delta", delta: " Tell the kanban chat", end_ms: 1000 });
      live.event({ type: "session.delegation.created", delegation: { id: "item_2", target: "client" } });
      await vi.advanceTimersByTimeAsync(300);
      live.event({ type: "session.input_transcript.delta", delta: " to add a test.", end_ms: 1400 });
      await vi.advanceTimersByTimeAsync(300);
      expect(ask).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(800);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0]![0]).toMatch(/since the last hand-off: Tell the kanban chat to add a test\.$/);
      await vi.advanceTimersByTimeAsync(5000);
      await live.idle();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends words that come soon after a hand-off as a follow-up, so the brain can correct what it sent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const events: CallEvent[] = [];
      const ask = vi.fn(async (prompt: string) => (prompt.startsWith("The user went on") ? "I also told the release chat to run the tests first." : "I told the release chat to push."));
      const live = new LiveCall({ ask: (prompt) => ask(prompt), emit: (event) => events.push(event) });
      live.event({ type: "session.input_transcript.delta", delta: " Tell the release chat to push", end_ms: 1000 });
      await vi.advanceTimersByTimeAsync(700);
      live.event({ type: "session.delegation.created", delegation: { id: "d", target: "client" } });
      await vi.advanceTimersByTimeAsync(1100);
      expect(ask).toHaveBeenCalledTimes(1);
      live.event({ type: "session.input_transcript.delta", delta: " but run the tests first.", end_ms: 2500 });
      await vi.advanceTimersByTimeAsync(3000);
      await live.idle();
      expect(ask.mock.calls[1]![0]).toMatch(/^The user went on talking after the hand-off you just answered, and said: but run the tests first\./);
      expect(events.filter((event) => event.type === "send").map((event) => (event.type === "send" ? event.event.content : ""))).toEqual([
        "I told the release chat to push.",
        "I also told the release chat to run the tests first.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing more when the follow-up changes nothing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const events: CallEvent[] = [];
      const live = new LiveCall({ ask: async (prompt) => (prompt.startsWith("The user went on") ? "NOTHING" : "Sent."), emit: (event) => events.push(event) });
      live.event({ type: "session.input_transcript.delta", delta: " Tell the release chat to push.", end_ms: 1000 });
      live.event({ type: "session.delegation.created", delegation: { id: "d", target: "client" } });
      await vi.advanceTimersByTimeAsync(1800);
      live.event({ type: "session.input_transcript.delta", delta: " Thanks.", end_ms: 2500 });
      await vi.advanceTimersByTimeAsync(3000);
      await live.idle();
      expect(events.filter((event) => event.type === "send")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each hand-off only the words since the last one, in order", async () => {
    const { call, ask, advance, settle } = setup(async (prompt) => (prompt.includes("kanban") ? "Asked the kanban chat." : "Sent."));
    words(call, "user", " Tell the release chat to push.", 2000);
    await advance(1000);
    delegation(call, "a");
    await settle();
    words(call, "assistant", " Done.", 3000);
    words(call, "user", " And ask the kanban chat if its test passes.", 5000);
    await advance(1000);
    delegation(call, "b");
    await settle();
    expect(ask.mock.calls.map(([prompt]) => prompt.split("hand-off: ")[1])).toEqual(["Tell the release chat to push.", "And ask the kanban chat if its test passes."]);
  });

  it("tells GPT-Live when the chats could not answer", async () => {
    const { call, events, advance, settle } = setup(async () => {
      throw new Error("the voice chat's model failed");
    });
    words(call, "user", " What is running?", 1000);
    await advance(1000);
    delegation(call, "x");
    await settle();
    expect(events).toContainEqual({ type: "error", message: "the voice chat's model failed" });
    expect(events).toContainEqual({ type: "send", event: expect.objectContaining({ delegation_id: "x", content: "That did not work: the voice chat's model failed." }) });
  });

  it("ignores Responses delegations and stops answering once ended", async () => {
    const { call, ask, events, advance, settle } = setup();
    call.event({ type: "session.delegation.created", delegation: { id: "r", target: "responses" } });
    words(call, "user", " hi", 1000);
    await advance(1000);
    call.end();
    delegation(call, "late");
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("Voice", () => {
  const deps = (overrides: Partial<VoiceDeps> = {}) => {
    const statuses: unknown[] = [];
    const brain = { warm: vi.fn(), ask: vi.fn(async () => "ok"), end: vi.fn() };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0 answer" } }), { status: 201 }));
    const d: VoiceDeps = { key: async () => "sk-proj-test", fetch: fetch as unknown as typeof globalThis.fetch, brain: () => brain, onStatus: (status) => statuses.push(status), onEvent: () => undefined, ...overrides };
    return { d, statuses, brain, fetch };
  };

  it("is ready with a key, and says what is missing without one", async () => {
    const ready = deps();
    new Voice(ready.d).setEnabled(true);
    await vi.waitFor(() => expect(ready.statuses).toEqual([{ phase: "ready" }]));
    const missing = deps({ key: async () => undefined });
    new Voice(missing.d).setEnabled(true);
    await vi.waitFor(() => expect(missing.statuses).toEqual([{ phase: "error", error: "No OpenAI API key yet." }]));
  });

  it("creates a GPT-Live session with client delegation from the window's offer and returns the answer", async () => {
    const { d, fetch, brain } = deps();
    const voice = new Voice(d);
    voice.setEnabled(true);
    expect(await voice.startCall("call-1", "/code/app", "v=0 offer")).toBe("v=0 answer");
    expect(brain.warm).toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-proj-test");
    expect(JSON.parse(String(init.body))).toEqual({
      session: { model: "gpt-live-1", instructions: LIVE_INSTRUCTIONS, audio: { output: { voice: "marin" } }, delegation: { type: "client" } },
      transport: { type: "webrtc", sdp: "v=0 offer" },
    });
    voice.event("call-1", { type: "session.closed" });
    expect(brain.end).toHaveBeenCalled();
  });

  it("explains a refused key and lets the call go", async () => {
    const { d, brain } = deps({ fetch: (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })) as unknown as typeof fetch });
    const voice = new Voice(d);
    voice.setEnabled(true);
    await expect(voice.startCall("call-1", "/code/app", "v=0")).rejects.toThrow("OpenAI refused the API key (401). Store it again.");
    expect(brain.end).toHaveBeenCalled();
  });
});
