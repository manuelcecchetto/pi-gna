#!/usr/bin/env node
// Dev tool: a stand-in for `pi --mode rpc` that streams a long text answer to every prompt, for
// checking streaming UI (scrolling, live states) without a model. Point a test instance at it:
//   PIGNA_PI_BIN=$PWD/scripts/fake-pi.mjs FAKE_LINES=400 FAKE_DELAY=100 node bin/pi-gna.mjs ...
// FAKE_LINES paragraphs, one every FAKE_DELAY ms (about 13 tokens each, so 150 ms is ~89 tok/s). Like pi, it names a
// session file (in the temp folder) before writing anything, so cards and laments can link its chats; none is written.
// FAKE_FIXTURE=<name> (see fake-pi-visuals.mjs) replies with that fixed text instead, FAKE_CHUNK chars per delta.
// `abort` ends the answer early, as Stop and Esc do with pi.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fixtureText } from "./fake-pi-visuals.mjs";

const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const model = { id: "fake", name: "Fake", api: "fake", provider: "fake", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const LINES = Number(process.env.FAKE_LINES || 80);
const DELAY = Number(process.env.FAKE_DELAY || 120);
let streaming = false;
let aborted = false;
const sessionFile = join(tmpdir(), "fake-pi-sessions", `${process.pid}.jsonl`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const reply = (data) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "get_state":
      return reply({ model, thinkingLevel: "off", isStreaming: streaming, isCompacting: false, steeringMode: "all", followUpMode: "all", sessionId: "fake", sessionFile, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 });
    case "get_available_models":
      return reply({ models: [model, { ...model, id: "fake-large", name: "Fake Large", reasoning: true }, { ...model, id: "fake", provider: "other-fake" }] });
    case "get_session_stats":
      return reply({ sessionId: "fake", userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    case "prompt":
      reply(undefined);
      return void run(command.message);
    case "abort":
      aborted = streaming;
      return reply(undefined);
    default:
      return reply(undefined);
  }
});

async function run(text) {
  streaming = true;
  aborted = false;
  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "user", content: text, timestamp: Date.now() } });
  out({ type: "message_end", message: { role: "user", content: text, timestamp: Date.now() } });
  const base = { role: "assistant", content: [], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
  out({ type: "message_start", message: base });
  out({ type: "message_update", message: base, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  let body = "";
  const fixture = process.env.FAKE_FIXTURE ? fixtureText(process.env.FAKE_FIXTURE) : undefined;
  const chunk = Number(process.env.FAKE_CHUNK || 40);
  const count = fixture ? Math.ceil(fixture.length / chunk) : LINES;
  for (let i = 1; i <= count && !aborted; i++) {
    await new Promise((resolve) => setTimeout(resolve, DELAY));
    const delta = fixture ? fixture.slice((i - 1) * chunk, i * chunk) : `Line ${i} of the streamed answer, long enough to read.\n\n`;
    body += delta;
    out({ type: "message_update", message: base, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  out({ type: "message_update", message: base, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: body } });
  // Like providers, report the output token count only at the end.
  const output = Math.round(body.length / 4);
  const stopReason = aborted ? "aborted" : "stop";
  out({ type: "message_end", message: { ...base, stopReason, content: [{ type: "text", text: body }], usage: { ...usage, output, totalTokens: output } } });
  streaming = false;
  out({ type: "agent_end", messages: [] });
  out({ type: "agent_settled" });
}
