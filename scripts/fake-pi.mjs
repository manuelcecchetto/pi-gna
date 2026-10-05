#!/usr/bin/env node
// Dev tool: a stand-in for `pi --mode rpc` that streams a long text answer to every prompt, for
// checking streaming UI (scrolling, live states) without a model. Point a test instance at it:
//   PIGNA_PI_BIN=$PWD/scripts/fake-pi.mjs FAKE_LINES=400 FAKE_DELAY=100 node bin/pi-gna.mjs ...
// FAKE_LINES paragraphs, one every FAKE_DELAY ms (about 13 tokens each, so 150 ms is ~89 tok/s). Like pi, it names a
// session file (in the temp folder) before writing anything, so cards and laments can link its chats; none is written.
// FAKE_FIXTURE=<name> (see fake-pi-visuals.mjs) replies with that fixed text instead, FAKE_CHUNK chars per delta.
// FAKE_ATP=1: a prompt that assigns an ATP node (the runner's claim packet) is answered by completing that node with the
// plan's librarian CLI, so a throwaway plan runs end to end; FAKE_ATP=idle leaves the node claimed (a worker that gave up).
// `abort` ends the answer early, as Stop and Esc do with pi.
// Composer chrome: get_commands, thinking levels (large models offer them), set_model / set_thinking_level, compact and
// session stats with a context size. A prompt containing "ext-ui" raises extension UI (a startup-style warning notify,
// a widget above the editor, set_editor_text, setTitle); "retry-demo" shows an auto-retry for a moment.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fixtureText } from "./fake-pi-visuals.mjs";

const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const model = { id: "fake", name: "Fake", api: "fake", provider: "fake", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const LINES = Number(process.env.FAKE_LINES || 80);
const DELAY = Number(process.env.FAKE_DELAY || 120);
// A prompt may carry `[lines=N]` and `[delay=N]` to override FAKE_LINES / FAKE_DELAY for that answer (scripts/remote-slice-e2e.mjs).
const directive = (text, name, fallback) => Number(text.match(new RegExp(`\\[${name}=(\\d+)\\]`))?.[1] ?? fallback);
let current = model;
let thinkingLevel = "off";
let compactions = 0;
const commandsList = [
  { name: "compact", description: "Summarize older messages now", source: "extension" },
  { name: "review", description: "Review the working tree", source: "prompt" },
  { name: "fake-skill", description: "A skill that does nothing", source: "skill" },
];
let streaming = false;
let aborted = false;
// Queued messages (steer / follow_up while streaming) so clear_queue and queue edits behave like pi's.
let queues = { steering: [], followUp: [] };
// `--session <file>` (an existing session opened from the list) is reported back as is, like pi does.
const resumed = process.argv.indexOf("--session");
const sessionFile = resumed > 0 ? process.argv[resumed + 1] : join(tmpdir(), "fake-pi-sessions", `${process.pid}.jsonl`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const reply = (data) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "get_state":
      return reply({ model: current, thinkingLevel, isStreaming: streaming, isCompacting: false, steeringMode: "all", followUpMode: "all", sessionId: "fake", sessionFile, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 });
    case "get_available_models":
      return reply({ models: [model, { ...model, id: "fake-large", name: "Fake Large", reasoning: true }, { ...model, id: "fake", provider: "other-fake" }] });
    case "get_session_stats":
      return reply({
        sessionId: "fake", userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
        contextUsage: { tokens: compactions ? 20000 : 50000, contextWindow: current.contextWindow, percent: compactions ? 10 : 25 },
      });
    case "get_commands":
      return reply({ commands: commandsList });
    case "get_available_thinking_levels":
      return reply({ levels: current.reasoning ? ["off", "low", "medium", "high"] : ["off"] });
    case "set_model": {
      const found = [model, { ...model, id: "fake-large", name: "Fake Large", reasoning: true }, { ...model, id: "fake", provider: "other-fake" }].find((m) => m.id === command.modelId && m.provider === command.provider);
      if (!found) return out({ type: "response", id: command.id, command: command.type, success: false, error: "Unknown model" });
      current = found;
      if (!found.reasoning) thinkingLevel = "off";
      return reply(found);
    }
    case "set_thinking_level":
      thinkingLevel = command.level;
      return reply(undefined);
    case "compact":
      compactions += 1;
      out({ type: "compaction_start", reason: "manual" });
      return setTimeout(() => {
        out({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
        reply(undefined);
      }, 300);
    case "prompt":
      reply(undefined);
      if (streaming) {
        queues[command.streamingBehavior === "followUp" ? "followUp" : "steering"].push(command.message);
        return out({ type: "queue_update", ...queues });
      }
      // A prompt containing "echo-attach" is echoed back with the number of images it carried (attachment checks).
      return void run(command.message.includes("echo-attach") ? `${command.message}\n[images=${command.images?.length ?? 0}]` : command.message);
    case "steer":
    case "follow_up":
      queues[command.type === "steer" ? "steering" : "followUp"].push(command.message);
      out({ type: "queue_update", ...queues });
      return reply(undefined);
    case "clear_queue": {
      const cleared = queues;
      queues = { steering: [], followUp: [] };
      out({ type: "queue_update", ...queues });
      return reply(cleared);
    }
    // A prompt containing "ask-confirm" raises a confirm dialog; the answer is appended to FAKE_RESPONSES (default in the temp folder).
    case "extension_ui_response":
      return void appendFileSync(process.env.FAKE_RESPONSES || join(tmpdir(), "fake-pi-responses.log"), `${JSON.stringify(command)}\n`);
    case "abort":
      aborted = streaming;
      return reply(undefined);
    default:
      return reply(undefined);
  }
});

/** The worker's part of an ATP node: complete it through the librarian, like a pi following the claim packet. */
function completeNode(text) {
  const node = text.match(/TASK ASSIGNED: (\S+)/)?.[1];
  const plan = text.match(/plan_path: (\S+)/)?.[1];
  const librarian = text.match(/librarian: python3 '([^']+)'/)?.[1];
  if (!node || !plan || !librarian || process.env.FAKE_ATP !== "1") return;
  const report = join(tmpdir(), `fake-pi-${process.pid}-report.md`);
  writeFileSync(report, "## Outcome\nDone by fake-pi.\n");
  execFileSync("python3", [librarian, "atp-complete-task", "--plan-path", plan, "--node-id", node, "--status", "DONE", "--report-file", report]);
}

async function run(text) {
  completeNode(text);
  streaming = true;
  aborted = false;
  out({ type: "agent_start" });
  if (text.includes("ext-ui")) {
    const ui = (fields) => out({ type: "extension_ui_request", id: `ui-${process.pid}-${Date.now()}-${Math.random()}`, ...fields });
    ui({ method: "notify", message: "fake-ext: heads up", notifyType: "warning" });
    ui({ method: "setWidget", widgetKey: "fake", widgetLines: ["fake widget line"], widgetPlacement: "aboveEditor" });
    ui({ method: "setTitle", title: "Fake extension title" });
    ui({ method: "set_editor_text", text: "prefilled by fake-ext" });
  }
  if (text.includes("retry-demo")) out({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
  if (text.includes("ask-confirm")) out({ type: "extension_ui_request", id: `confirm-${process.pid}-${Date.now()}`, method: "confirm", title: "Run the fake tool?", message: "Approve to continue." });
  out({ type: "message_start", message: { role: "user", content: text, timestamp: Date.now() } });
  out({ type: "message_end", message: { role: "user", content: text, timestamp: Date.now() } });
  const base = { role: "assistant", content: [], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
  out({ type: "message_start", message: base });
  out({ type: "message_update", message: base, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  let body = "";
  const fixture = process.env.FAKE_FIXTURE ? fixtureText(process.env.FAKE_FIXTURE) : undefined;
  const chunk = Number(process.env.FAKE_CHUNK || 40);
  const count = fixture ? Math.ceil(fixture.length / chunk) : directive(text, "lines", LINES);
  const delay = directive(text, "delay", DELAY);
  for (let i = 1; i <= count && !aborted; i++) {
    await new Promise((resolve) => setTimeout(resolve, delay));
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
