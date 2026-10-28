import { describe, expect, it, vi } from "vitest";
import type { AttentionSummary } from "../../shared/host-api";
import { type CallEvent, INPUT_RATE } from "../../shared/voice";
import { type CallDeps, ChatWatcher, type RealtimeEvent, VoiceCall } from "./call";

const samples = (ms: number, db: number) => {
  const amplitude = Math.sqrt(2) * 10 ** (db / 20);
  return Float32Array.from({ length: (INPUT_RATE * ms) / 1000 }, (_, i) => amplitude * Math.sin(i / 3));
};
const quiet = (ms: number) => samples(ms, -70);
const voice = (ms: number) => samples(ms, -25);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A /v1/realtime server that answers each response.create with the next scripted response. */
function fakeServer(responses: RealtimeEvent[][]) {
  const sent: Record<string, unknown>[] = [];
  let push: (event: RealtimeEvent) => void = () => undefined;
  const connect: CallDeps["connect"] = async (onEvent) => {
    push = onEvent;
    return {
      send: (event) => {
        sent.push(event);
        if (event.type === "session.update") queueMicrotask(() => push({ type: "session.updated" }));
        if (event.type === "response.create") {
          const script = responses.shift() ?? [];
          queueMicrotask(() => script.forEach((scripted) => push(scripted)));
        }
        if (event.type === "response.cancel") queueMicrotask(() => push({ type: "response.done", response: { status: "cancelled" } }));
      },
      close: () => undefined,
    };
  };
  return { connect, sent, types: () => sent.map((event) => event.type), push: (event: RealtimeEvent) => push(event) };
}

const say = (text: string): RealtimeEvent[] => [{ type: "response.output_text.delta", delta: text }, { type: "response.done" }];
const callTool = (name: string, args: object): RealtimeEvent[] => [
  { type: "response.function_call_arguments.done", call_id: `c-${name}`, name, arguments: JSON.stringify(args) },
  { type: "response.done" },
];

function setup(responses: RealtimeEvent[][], overrides: Partial<CallDeps> = {}) {
  const server = fakeServer(responses);
  const events: CallEvent[] = [];
  const spoken: string[] = [];
  const run = vi.fn(async (name: string, args: Record<string, unknown>) => ({ output: `${name} ok`, action: `${name} ${JSON.stringify(args)}` }));
  const call = new VoiceCall({
    connect: server.connect,
    async *tts(text) {
      spoken.push(text);
      yield new Float32Array(240);
    },
    tools: { run },
    instructions: "be brief",
    toolDefinitions: [],
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { call, server, events, spoken, run, states: () => events.flatMap((event) => (event.type === "state" ? [event.state] : [])) };
}

describe("VoiceCall", () => {
  it("streams a turn in while it is spoken, answers in text and says the answer", async () => {
    const { call, server, events, spoken, states } = setup([say("**Hello** there.")]);
    await call.start();
    expect(server.sent[0]).toMatchObject({ type: "session.update", session: { instructions: "be brief", output_modalities: ["text"], tool_choice: "auto" } });
    call.audio(quiet(400));
    expect(server.types()).toEqual(["session.update"]);
    call.audio(voice(600));
    // Audio goes in while the user still talks, with what came just before the turn started.
    expect(server.types()).toEqual(["session.update", "input_audio_buffer.append"]);
    call.audio(quiet(1000));
    await tick();
    await tick();
    expect(server.types().slice(-2)).toEqual(["input_audio_buffer.commit", "response.create"]);
    expect(spoken).toEqual(["Hello there."]);
    expect(events).toContainEqual({ type: "reply", text: "Hello there." });
    expect(events.filter((event) => event.type === "speech" || event.type === "speechEnd").map((event) => event.type)).toEqual(["speech", "speechEnd"]);
    expect(states()).toEqual(["connecting", "listening", "hearing", "thinking", "listening"]);
  });

  it("runs the tools a response calls, hands back their output and asks again", async () => {
    const { call, server, events, run, spoken } = setup([callTool("threads_list", {}), callTool("thread_read", { thread: "2" }), say("It is waiting for you.")]);
    await call.start();
    call.audio(quiet(200));
    call.audio(voice(600));
    call.audio(quiet(1000));
    for (let i = 0; i < 10; i++) await tick();
    expect(run.mock.calls).toEqual([
      ["threads_list", {}],
      ["thread_read", { thread: "2" }],
    ]);
    expect(server.sent.filter((event) => event.type === "conversation.item.create")).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c-threads_list", output: "threads_list ok" } },
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c-thread_read", output: "thread_read ok" } },
    ]);
    expect(events).toContainEqual({ type: "action", text: 'thread_read {"thread":"2"}' });
    expect(spoken).toEqual(["It is waiting for you."]);
  });

  it("does not hear its own voice: the microphone is ignored while it speaks and just after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { call, server, states } = setup([say("This is the answer.")]);
      await call.start();
      call.audio(quiet(200));
      call.audio(voice(600));
      call.audio(quiet(1000));
      for (let i = 0; i < 5; i++) await tick();
      const sent = server.sent.length;
      call.control({ playing: true });
      // Its own voice, loud, from the speakers.
      call.audio(samples(1500, -10));
      call.control({ playing: false });
      call.audio(samples(500, -10));
      expect(server.sent.length).toBe(sent);
      expect(states().at(-1)).toBe("listening");
      vi.advanceTimersByTime(800);
      call.audio(quiet(200));
      call.audio(voice(600));
      expect(states().at(-1)).toBe("hearing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a response being written when the user goes on talking, then answers both", async () => {
    const { call, server } = setup([[], say("Both done.")]);
    await call.start();
    call.audio(quiet(200));
    call.audio(voice(600));
    call.audio(quiet(1000));
    await tick();
    // The first response is still being written (the script sends nothing): the user goes on.
    call.audio(voice(600));
    await tick();
    expect(server.types()).toContain("response.cancel");
    call.audio(quiet(1000));
    for (let i = 0; i < 5; i++) await tick();
    const types = server.types();
    const cancel = types.indexOf("response.cancel");
    // The audio held while the cancel wound down goes in first, then the rest of the turn, then one answer for both.
    const after = types.slice(cancel + 1);
    expect(after[0]).toBe("input_audio_buffer.append");
    expect(after.filter((type) => type !== "input_audio_buffer.append")).toEqual(["input_audio_buffer.commit", "response.create"]);
  });

  it("answers in text only while the assistant is muted", async () => {
    const { call, events, spoken } = setup([say("Quiet answer.")]);
    await call.start();
    call.control({ assistantMuted: true });
    call.audio(quiet(200));
    call.audio(voice(600));
    call.audio(quiet(1000));
    for (let i = 0; i < 5; i++) await tick();
    expect(spoken).toEqual([]);
    expect(events).toContainEqual({ type: "reply", text: "Quiet answer." });
  });

  it("drops a turn the microphone was muted in", async () => {
    const { call, server } = setup([]);
    await call.start();
    call.audio(quiet(200));
    call.audio(voice(600));
    call.micMuted();
    call.audio(quiet(1000));
    await tick();
    expect(server.types()).not.toContain("input_audio_buffer.commit");
  });

  it("ends when the session cannot open", async () => {
    const { call, events } = setup([], { connect: () => Promise.reject(new Error("refused")) });
    await call.start();
    expect(events.slice(-2)).toEqual([
      { type: "error", message: "The voice model did not answer: refused" },
      { type: "ended", reason: "failed" },
    ]);
  });
});

describe("ChatWatcher", () => {
  const chat = (title: string, running: boolean, attention: AttentionSummary["attention"], cwd = "/p"): AttentionSummary => ({
    handle: title,
    cwd,
    sessionPath: `/s/${title}.jsonl`,
    title,
    listed: true,
    attention,
    running,
    dialogs: 0,
  });

  it("tells which of the project's chats finished, failed or need the user since the last look", () => {
    const watcher = new ChatWatcher((summary) => summary.cwd === "/p");
    expect(watcher.look([chat("A", true, "running"), chat("B", true, "running"), chat("C", false, "idle"), chat("D", true, "running", "/other")])).toEqual([]);
    expect(watcher.look([chat("A", false, "unread"), chat("B", false, "failed"), chat("C", false, "waiting"), chat("D", false, "unread", "/other")])).toEqual([
      "A finished.",
      "B failed.",
      "C needs you.",
    ]);
    expect(watcher.look([chat("A", false, "unread"), chat("B", false, "failed"), chat("C", false, "waiting")])).toEqual([]);
  });
});
