import { describe, expect, it, vi } from "vitest";
import { type CallEvent, INPUT_RATE } from "../../shared/voice";
import { type CallDeps, type RealtimeEvent, VoiceCall } from "./call";

const samples = (ms: number, db: number) => {
  const amplitude = Math.sqrt(2) * 10 ** (db / 20);
  return Float32Array.from({ length: (INPUT_RATE * ms) / 1000 }, (_, i) => amplitude * Math.sin(i / 3));
};
const quiet = (ms: number) => samples(ms, -70);
const voice = (ms: number) => samples(ms, -25);
/** Lets queued work run; microtasks only, so it also works under fake timers. */
const tick = async (n = 5) => {
  for (let i = 0; i < n * 20; i++) await Promise.resolve();
};

/** A transcription session that writes down each commit as the next scripted transcript. */
function fakeServer(transcripts: string[]) {
  const sent: Record<string, unknown>[] = [];
  let push: (event: RealtimeEvent) => void = () => undefined;
  const connect: CallDeps["connect"] = async (onEvent) => {
    push = onEvent;
    return {
      send: (event) => {
        sent.push(event);
        if (event.type === "session.update") queueMicrotask(() => push({ type: "session.updated" }));
        if (event.type === "input_audio_buffer.commit") {
          const transcript = transcripts.shift() ?? "";
          queueMicrotask(() => push({ type: "conversation.item.input_audio_transcription.completed", transcript }));
        }
      },
      close: () => undefined,
    };
  };
  return { connect, sent, types: () => sent.map((event) => event.type) };
}

function setup(transcripts: string[], answer: (said: string, signal: AbortSignal) => Promise<string> = async (said) => `You said ${said}.`, overrides: Partial<CallDeps> = {}) {
  const server = fakeServer(transcripts);
  const events: CallEvent[] = [];
  const spoken: string[] = [];
  const ask = vi.fn(answer);
  const call = new VoiceCall({
    connect: server.connect,
    async *tts(text) {
      spoken.push(text);
      yield new Float32Array(240);
    },
    ask,
    emit: (event) => events.push(event),
    ...overrides,
  });
  const states = () => events.flatMap((event) => (event.type === "state" ? [event.state] : []));
  const talk = async () => {
    call.audio(quiet(400));
    call.audio(voice(600));
    call.audio(quiet(1000));
    await tick();
  };
  return { call, server, events, spoken, ask, states, talk };
}

describe("VoiceCall", () => {
  it("writes down a turn, asks the brain with the words and says its answer", async () => {
    const { call, server, events, spoken, ask, states, talk } = setup(["Ciao."], async () => "**Ciao!** How can I help?");
    await call.start();
    expect(server.sent[0]).toEqual({ type: "session.update", session: { type: "transcription" } });
    await talk();
    expect(server.types().filter((type) => type !== "input_audio_buffer.append")).toEqual(["session.update", "input_audio_buffer.commit"]);
    expect(ask.mock.calls.map(([said]) => said)).toEqual(["Ciao."]);
    expect(events).toContainEqual({ type: "heard", text: "Ciao." });
    expect(events).toContainEqual({ type: "reply", text: "Ciao! How can I help?" });
    expect(spoken).toEqual(["Ciao! How can I help?"]);
    expect(states()).toEqual(["connecting", "listening", "hearing", "thinking", "listening"]);
  });

  it("asks nothing when nothing was written down (a noise)", async () => {
    const { call, ask, events, states, talk } = setup([""]);
    await call.start();
    await talk();
    expect(ask).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "heard")).toBe(false);
    expect(states().at(-1)).toBe("listening");
  });

  it("waits for you: going on while it thinks drops that answer and asks once about all of it", async () => {
    const asked: string[] = [];
    let first = true;
    const { call, spoken, talk } = setup(["Tell the release chat to push.", "But run the tests first."], (said, signal) => {
      asked.push(said);
      if (first) {
        first = false;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
      }
      return Promise.resolve("Sent.");
    });
    await call.start();
    await talk();
    expect(asked).toEqual(["Tell the release chat to push."]);
    await talk();
    expect(asked).toEqual(["Tell the release chat to push.", "Tell the release chat to push. But run the tests first."]);
    expect(spoken).toEqual(["Sent."]);
  });

  it("gives what sounds unfinished more time before it answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { call, ask, states, talk } = setup(["Tell the release chat to push and", "run the tests first."]);
      await call.start();
      await talk();
      expect(ask).not.toHaveBeenCalled();
      expect(states().at(-1)).toBe("listening");
      await talk();
      expect(ask.mock.calls.map(([said]) => said)).toEqual(["Tell the release chat to push and run the tests first."]);
      const { call: other, ask: otherAsk, talk: otherTalk } = setup(["So, um"]);
      await other.start();
      await otherTalk();
      expect(otherAsk).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1600);
      await tick();
      expect(otherAsk.mock.calls.map(([said]) => said)).toEqual(["So, um"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hear its own voice while its speech plays and just after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { call, server, ask, states, talk } = setup(["Which chats run?", "Second."]);
      await call.start();
      await talk();
      const appended = () => server.types().filter((type) => type === "input_audio_buffer.append").length;
      const before = appended();
      call.control({ playing: true });
      call.audio(samples(1500, -10));
      call.control({ playing: false });
      call.audio(samples(400, -10));
      expect(appended()).toBe(before);
      expect(states().at(-1)).toBe("listening");
      vi.advanceTimersByTime(800);
      await talk();
      expect(ask.mock.calls.map(([said]) => said)).toEqual(["Which chats run?", "Second."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops thinking when asked to, and listens again", async () => {
    let signal: AbortSignal | undefined;
    const { call, events, spoken, states, talk } = setup(["Do a long thing."], (_said, abort) => {
      signal = abort;
      return new Promise(() => undefined);
    });
    await call.start();
    await talk();
    expect(states().at(-1)).toBe("thinking");
    call.control({ interrupt: true });
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(events).toContainEqual({ type: "flush" });
    expect(states().at(-1)).toBe("listening");
    expect(spoken).toEqual([]);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("says nothing while the assistant is muted, but shows the answer", async () => {
    const { call, events, spoken, talk } = setup(["Hi."], async () => "Hello there.");
    await call.start();
    call.control({ assistantMuted: true });
    await talk();
    expect(spoken).toEqual([]);
    expect(events).toContainEqual({ type: "reply", text: "Hello there." });
  });

  it("shows the brain's failure and listens again", async () => {
    const { call, events, states, talk } = setup(["Hi."], async () => {
      throw new Error("the voice chat's model failed");
    });
    await call.start();
    await talk();
    expect(events).toContainEqual({ type: "error", message: "the voice chat's model failed" });
    expect(states().at(-1)).toBe("listening");
  });

  it("ends when the session cannot open", async () => {
    const { call, events } = setup([], undefined, { connect: () => Promise.reject(new Error("refused")) });
    await call.start();
    expect(events.slice(-2)).toEqual([
      { type: "error", message: "The voice model did not answer: refused" },
      { type: "ended", reason: "failed" },
    ]);
  });
});
