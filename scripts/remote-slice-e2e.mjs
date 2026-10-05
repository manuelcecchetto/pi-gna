#!/usr/bin/env node
// End to end test of the remote vertical slice, without a phone (docs/REMOTE.md, "Automated end-to-end test"):
// pairing, open, prompt, streaming, approvals, cancellation, reconnect and recovery, closing clients mid-run, and
// screenshots of the mobile screens. Run it from the repo root:
//   node scripts/remote-slice-e2e.mjs [--keep] [--no-build] [--shots <dir>] [--hold] [--screens-only] [--debug]
// It builds the app into its own folder under the temp dir, starts a test instance there (own PIGNA_USER_DATA,
// own free ports, PIGNA_BACKGROUND=1, scripts/fake-pi.mjs as pi), drives it as two paired phones (HTTP + SSE, like
// the HostClient) and as the desktop window (CDP), and stops it by PID. Nothing touches a running pi-gna.
// Exit code 0 only when every check passed. Uses Node's built-in fetch/WebSocket/http; no dependencies.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = process.argv.slice(2);
const flag = (name) => flags.includes(name);
const shotsDir = flags.includes("--shots") ? flags[flags.indexOf("--shots") + 1] : undefined;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => console.log(line);
const failures = [];
/** One assertion: printed as it happens, collected, and decides the exit code. */
function check(ok, label, detail) {
  log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}
async function until(what, probe, timeoutMs = 20_000, everyMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

// ── The test instance ────────────────────────────────────────────────────────

const base = realpathSync(tmpdir());
const work = join(base, `pigna-slice-e2e-${randomUUID().slice(0, 8)}`);
// SLICE_E2E_APP=<folder> with --no-build reuses an earlier build (a folder this script made).
const appDir = process.env.SLICE_E2E_APP ?? join(work, "app");
const userData = join(work, "ud");
const project = join(work, "project");
const agentDir = join(work, "agent");
const sessionsDir = join(agentDir, "sessions");
const responses = join(work, "fake-pi-responses.log");
let instance;
let proxy;

function build() {
  mkdirSync(appDir, { recursive: true });
  // One build id for both bundles, as scripts/build.mjs does: the phone reloads itself when /api/hello disagrees with it.
  const env = { PIGNA_BUILD: "slice-e2e" };
  const run = (args) => {
    const result = spawnSync("pnpm", ["exec", ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  };
  run(["electron-vite", "build", "--outDir", join(appDir, "out")]);
  run(["vite", "build", "-c", "vite.mobile.config.ts", "--outDir", join(appDir, "out", "mobile"), "--emptyOutDir"]);
  copyFileSync(join(root, "package.json"), join(appDir, "package.json"));
  // The extensions import ../src/shared, and the app reads resources next to itself.
  for (const dir of ["node_modules", "resources", "src"]) symlinkSync(join(root, dir), join(appDir, dir));
}

/** A throwaway project with one existing session (a few turns), listed by pi-gna from our own agent folder. */
function seed(ports) {
  mkdirSync(project, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: project });
  const dir = join(sessionsDir, `--${project.slice(1).replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  const id = "01a20000-0000-7000-8000-000000000002";
  const file = join(dir, `2026-10-05T00-00-00-000Z_${id}.jsonl`);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-10-04T21:40:00.000Z", cwd: project }];
  let parent = null;
  for (let n = 1; n <= 3; n++) {
    const user = { type: "message", id: `u${n}aaaaaa`, parentId: parent, timestamp: `2026-10-04T21:4${n}:00.000Z`, message: { role: "user", content: [{ type: "text", text: `Earlier question ${n}` }], timestamp: 1791150000000 + n * 1000 } };
    const answer = { type: "message", id: `a${n}bbbbbb`, parentId: user.id, timestamp: `2026-10-04T21:4${n}:01.000Z`, message: { role: "assistant", content: [{ type: "text", text: `Earlier answer ${n}.` }], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: 1791150001000 + n * 1000 } };
    lines.push(user, answer);
    parent = answer.id;
  }
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  mkdirSync(userData, { recursive: true });
  // Remote access on through the profile's settings; the server follows them at launch.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ version: 1, remote: { enabled: true, port: ports.remote, keepAwake: "off" } }));
  return file;
}

function launch(ports) {
  const electron = spawnSync("node", ["-e", 'console.log(require("electron"))'], { cwd: root, encoding: "utf8" }).stdout.trim();
  const env = { ...process.env };
  delete env.PIGNA_CWD;
  Object.assign(env, {
    PIGNA_USER_DATA: userData,
    PIGNA_BACKGROUND: "1",
    PIGNA_REMOTE_LOOPBACK: "1",
    PIGNA_CWD: project,
    PIGNA_PI_BIN: join(root, "scripts", "fake-pi.mjs"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    FAKE_RESPONSES: responses,
    FAKE_LINES: "60",
    FAKE_DELAY: "60",
  });
  const out = openSync(join(work, "app.log"), "a");
  const child = spawn(electron, [appDir, `--remote-debugging-port=${ports.debug}`, `--inspect=${ports.inspect}`], { env, stdio: ["ignore", out, out], detached: false });
  closeSync(out);
  return child;
}

async function stopInstance() {
  if (!instance || instance.exitCode !== null) return;
  // By PID only (docs/DESIGN.md "Verifying the UI"): never a pattern kill, which could take down the user's own pi-gna.
  instance.kill("SIGTERM");
  const end = Date.now() + 8000;
  while (instance.exitCode === null && Date.now() < end) await sleep(100);
  if (instance.exitCode === null) instance.kill("SIGKILL");
}

// ── The desktop window, over CDP ─────────────────────────────────────────────

class Cdp {
  static async open(wsUrl) {
    const cdp = new Cdp();
    cdp.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.ws.onopen = resolve;
      cdp.ws.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
    });
    cdp.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiting = cdp.pending.get(message.id);
      if (!waiting) return;
      cdp.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    };
    return cdp;
  }
  seq = 0;
  pending = new Map();
  send(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

// ── A phone: the HostClient's wire protocol, by hand ─────────────────────────

/** Minimal HTTP over node:http, so Host/Origin/cookies are exactly what Tailscale serve + Safari would send. */
function request(port, { method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** An open SSE stream; `events` collects every `host` frame, `frames` every frame (hello/resync too). */
class Sse {
  frames = [];
  events = [];
  closed = false;
  constructor(phone, chats, lastEventId) {
    const headers = phone.headers();
    if (lastEventId) headers["last-event-id"] = lastEventId;
    this.req = http.request({ host: "127.0.0.1", port: phone.port, method: "GET", path: `/api/events?stream=${phone.stream}&chats=${chats.join(",")}`, headers }, (res) => {
      this.status = res.statusCode;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          this.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      });
      res.on("close", () => (this.closed = true));
    });
    this.req.on("error", () => (this.closed = true));
    this.req.end();
  }
  parse(block) {
    const frame = { id: undefined, event: "message", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id: ")) frame.id = line.slice(4);
      else if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("data: ")) frame.data += line.slice(6);
    }
    if (!frame.data) return;
    frame.json = JSON.parse(frame.data);
    this.frames.push(frame);
    if (frame.event === "host") this.events.push(frame.json);
  }
  get lastId() {
    return this.events.length ? `${this.events.at(-1).bootId}:${this.events.at(-1).seq}` : undefined;
  }
  /** Closing the socket is how a phone dropping off the network looks to the host. */
  drop() {
    this.req.destroy();
    this.closed = true;
  }
}

class Phone {
  constructor(port, name, login) {
    this.port = port;
    this.name = name;
    this.login = login;
    this.stream = randomUUID();
    this.cookie = undefined;
  }
  headers(extra = {}) {
    return { host: `127.0.0.1:${this.port}`, "tailscale-user-login": this.login, "x-pigna-client": "1", origin: `https://127.0.0.1:${this.port}`, ...(this.cookie ? { cookie: this.cookie } : {}), ...extra };
  }
  async json(method, path, body, extra = {}) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const res = await request(this.port, { method, path, headers: this.headers({ "content-type": "application/json", ...(text ? { "content-length": Buffer.byteLength(text) } : {}), ...extra }), body: text });
    let value;
    try {
      value = res.text ? JSON.parse(res.text) : null;
    } catch {
      value = res.text;
    }
    return { status: res.status, headers: res.headers, value };
  }
  /** A host call; mutating methods carry an Idempotency-Key (a fresh one unless given). */
  async call(method, args = {}, { key = randomUUID(), boot } = {}) {
    const res = await this.json("POST", `/api/call/${method}`, args, { "x-pigna-stream": this.stream, "idempotency-key": key, ...(boot ? { "x-pigna-boot": boot } : {}) });
    return res;
  }
  /** Like call, but throws unless 200. */
  async ok(method, args, options) {
    const res = await this.call(method, args, options);
    if (res.status !== 200) throw new Error(`${this.name} ${method} -> ${res.status} ${JSON.stringify(res.value)}`);
    return res.value;
  }
  subscribe(chats) {
    return this.json("POST", "/api/subscribe", { stream: this.stream, chats });
  }
  events(chats, lastEventId) {
    return new Sse(this, chats, lastEventId);
  }
}

// ── Reading a chat out of events ─────────────────────────────────────────────

const records = (events, topic) => events.filter((e) => e.topic === topic && e.event.kind === "rpc").map((e) => e.event.record);
/** The assistant text deltas of a stream, in order. */
const deltas = (events, topic) => records(events, topic).filter((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta").map((r) => r.assistantMessageEvent.delta);
const messageEnds = (events, topic, role) => records(events, topic).filter((r) => r.type === "message_end" && r.message.role === role);
const userTexts = (events, topic) => messageEnds(events, topic, "user").map((r) => (typeof r.message.content === "string" ? r.message.content : r.message.content.map((c) => c.text).join("")));
const lineNumbers = (events, topic) => deltas(events, topic).map((d) => Number(/^Line (\d+) /.exec(d)?.[1]));
const contiguous = (numbers) => numbers.length > 0 && numbers.every((n, i) => n === numbers[0] + i);
const agentEnds = (events, topic) => records(events, topic).filter((r) => r.type === "agent_end").length;
const finalText = (events, topic) => messageEnds(events, topic, "assistant").at(-1)?.message.content.map((c) => c.text).join("") ?? "";
const lastLine = (text) => Number([...text.matchAll(/^Line (\d+) /gm)].at(-1)?.[1] ?? 0);

// ── Scenario ─────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(work, { recursive: true });
  log(`work folder ${work}`);
  if (!flag("--no-build")) {
    log("building the app into its own folder ...");
    build();
  } else if (!existsSync(join(appDir, "out"))) throw new Error("--no-build needs an earlier build");
  const ports = { debug: await freePort(), inspect: await freePort(), remote: await freePort() };
  const sessionFile = seed(ports);
  instance = launch(ports);
  log(`instance pid ${instance.pid}, debug ${ports.debug}, inspect ${ports.inspect}, remote ${ports.remote}`);

  const page = await until("the app window", async () => {
    try {
      return (await targets(ports.debug)).find((t) => t.type === "page" && t.url.startsWith("app://pigna"));
    } catch {
      return undefined;
    }
  }, 40_000, 250);
  const desktop = await Cdp.open(page.webSocketDebuggerUrl);
  await until("the app to render", () => desktop.eval("!!document.querySelector('#root')?.children.length"), 30_000, 250);
  await until("the remote server", async () => (await request(ports.remote, { path: "/api/hello", headers: { host: `127.0.0.1:${ports.remote}`, "tailscale-user-login": "a@example.com" } }).catch(() => ({ status: 0 }))).status === 200, 20_000, 250);

  const A = new Phone(ports.remote, "A", "alice@example.com");
  const B = new Phone(ports.remote, "B", "alice@example.com");

  try {
    await scenario({ A, B, desktop, ports, project, sessionFile });
  } finally {
    desktop.close();
  }
}

async function pairPhone(phone, desktop) {
  const status = await desktop.eval("window.studio.remote.pairStart()");
  const code = status.code;
  const claim = await phone.json("POST", "/api/pair", { code, deviceName: `iPhone ${phone.name}` });
  if (claim.status !== 200) throw new Error(`pair ${phone.name}: ${claim.status} ${JSON.stringify(claim.value)}`);
  const request = claim.value.request;
  const wait = request2(phone, `/api/pair/${request}/wait`);
  const pending = await until("the approval prompt", async () => {
    const s = await desktop.eval("window.studio.remote.pairing()");
    return s.state === "pending_approval" ? s : undefined;
  }, 10_000, 100);
  // The Mac's Allow button.
  await desktop.eval(`window.studio.remote.pairDecide(${JSON.stringify(pending.request.id)}, true)`);
  const result = await wait;
  const cookie = /pigna_device=[^;]+/.exec([result.headers["set-cookie"]].flat().join(";"))?.[0];
  if (!cookie) throw new Error(`pair ${phone.name}: no cookie (${result.text})`);
  phone.cookie = cookie;
  return { code, deviceName: pending.request.deviceName, login: pending.request.tailnetLogin };
}
const request2 = (phone, path) => request(phone.port, { path, headers: phone.headers() });

async function scenario(ctx) {
  const { A, B, desktop, sessionFile } = ctx;

  log("pairing");
  const pairedA = await pairPhone(A, desktop);
  check(pairedA.deviceName === "iPhone A", "the Mac's approval prompt names device A", pairedA);
  await pairPhone(B, desktop);
  check((await A.json("GET", "/api/hello")).value.authenticated === true, "A is authenticated after pairing");
  check((await B.json("GET", "/api/hello")).value.authenticated === true, "B is authenticated after pairing");
  const devices = await A.ok("devices.list");
  check(devices.length === 2, "two devices are paired", devices);
  check((await new Phone(ctx.ports.remote, "X", "alice@example.com").call("chat.list")).status === 401, "an unpaired client is refused");

  const cwd = ctx.project;
  const deviceA = devices.find((d) => d.name === "iPhone A");

  if (flag("--screens-only")) {
    // Development shortcut: skip the scenarios, just look at the mobile screens.
    await showSession(desktop, "Earlier question 1");
    const { handle } = await A.ok("chat.open", { request: { cwd, sessionPath: sessionFile } });
    return screens(ctx, { handle, A, B });
  }

  // ── Open ────────────────────────────────────────────────────────────────
  log("open an existing session");
  const opened = await A.ok("chat.open", { request: { cwd, sessionPath: sessionFile } });
  const handle = opened.handle;
  const topic = `chat:${handle}`;
  check(!opened.reused && /^[a-z0-9]{6,32}$/.test(handle), "A opens the session file and gets a host handle", opened);
  check(Array.isArray(opened.entries) && opened.entries.length === 0, "a remote open returns no entries (the phone reads chat.snapshot)");
  const openedB = await B.ok("chat.open", { request: { cwd, sessionPath: sessionFile } });
  check(openedB.reused === true && openedB.handle === handle, "B opening the same file attaches to the same handle", openedB);
  const snapshotA = await A.ok("chat.snapshot", { handle });
  check(JSON.stringify(snapshotA.value).includes("Earlier answer 3."), "A's snapshot holds the session's earlier turns");
  await showSession(desktop, "Earlier question 1");
  await until("the desktop to show the session", async () => (await desktopText(desktop)).includes("Earlier answer 3."));
  const live = await desktop.eval("window.studio.liveChats()");
  check(live.length === 1 && live[0].handle === handle, "the desktop shows the same live chat (one pi process for the file)", live);

  let sseA = A.events([handle]);
  const sseB = B.events([handle]);
  await until("both streams", () => sseA.frames.length > 0 && sseB.frames.length > 0);
  check(sseA.frames[0].event === "hello" && sseA.frames[0].json.bootId === sseB.frames[0].json.bootId, "both streams start with hello of the same boot");

  // ── Prompt, streaming and approvals ─────────────────────────────────────
  log("prompt from A, stream to A, B and the desktop; approval answered by A");
  const aAll = []; // A's events across reconnects
  const collectA = () => {
    for (const e of sseA.events) if (!aAll.includes(e)) aAll.push(e);
    return aAll;
  };
  let sent = await A.ok("chat.send", { handle, text: "first prompt ask-confirm [lines=40][delay=50]", mode: "send" });
  check(sent.accepted === true, "A's prompt is accepted", sent);
  const dialogRecord = await until("the confirm dialog on B", () => records(sseB.events, topic).find((r) => r.type === "extension_ui_request"));
  await until("the confirm dialog on A", () => records(sseA.events, topic).find((r) => r.type === "extension_ui_request"));
  await until("the confirm card on the desktop", async () => (await desktopText(desktop, true)).includes("Run the fake tool?"));
  check(true, "A, B and the desktop all show the approval");
  const answer = await A.call("chat.respondDialog", { handle, response: { type: "extension_ui_response", id: dialogRecord.id, confirmed: true } });
  check(answer.status === 200 && (answer.value === null || answer.value?.ok !== false), "A's answer is taken", answer);
  const resolvedB = await until("dialog_resolved on B", () => sseB.events.find((e) => e.topic === topic && e.event.kind === "dialog_resolved"));
  await until("dialog_resolved on A", () => sseA.events.find((e) => e.topic === topic && e.event.kind === "dialog_resolved"));
  check(resolvedB.event.id === dialogRecord.id && resolvedB.event.by?.device === deviceA.id && resolvedB.event.outcome === "answered", "B gets dialog_resolved naming A's device", resolvedB.event);
  await until("the card to leave the desktop", async () => !(await desktopText(desktop, true)).includes("Run the fake tool?"));
  check(true, "the desktop drops the card too");
  const second = await B.call("chat.respondDialog", { handle, response: { type: "extension_ui_response", id: dialogRecord.id, confirmed: false } });
  const lateCode = second.value?.code ?? second.value?.error?.code;
  check(lateCode === "already_answered", "B's later answer is already_answered", second);
  const logged = readFileSync(responses, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check(logged.length === 1 && logged[0].confirmed === true, "pi received exactly one answer (A's)", logged);

  await until("the run to end on A and B", () => agentEnds(sseA.events, topic) >= 1 && agentEnds(sseB.events, topic) >= 1, 30_000);
  await settled(desktop, handle);
  const numbersA = lineNumbers(collectA(), topic);
  const numbersB = lineNumbers(sseB.events, topic);
  check(numbersA.length === 40 && contiguous(numbersA) && numbersA[0] === 1, "A saw lines 1..40, no gaps or duplicates", numbersA.length);
  check(JSON.stringify(numbersA) === JSON.stringify(numbersB), "B saw the same lines as A");
  check(finalText(aAll, topic) === finalText(sseB.events, topic) && lastLine(finalText(aAll, topic)) === 40, "A and B end with the identical assistant message");
  check(await desktopHasLines(desktop, 40), "the desktop shows the same final message (lines 1..40, once each)");
  check(userTexts(sseB.events, topic)[0]?.startsWith("first prompt"), "the prompt is a user turn on B");

  // ── Cancel from B ───────────────────────────────────────────────────────
  log("cancel from B mid-stream");
  let markA = aAll.length;
  let markB = sseB.events.length;
  sent = await A.ok("chat.send", { handle, text: "cancel me [lines=2000][delay=30]", mode: "send" });
  await until("deltas on B", () => deltas(sseB.events.slice(markB), topic).length >= 5);
  const restored = await B.ok("chat.interrupt", { handle });
  check(Array.isArray(restored), "B's interrupt returns the restored queue", restored);
  await until("the run to end on A and B", () => agentEnds(collectA().slice(markA), topic) === 1 && agentEnds(sseB.events.slice(markB), topic) === 1);
  await settled(desktop, handle);
  const cancelA = collectA().slice(markA);
  const cancelB = sseB.events.slice(markB);
  const endedWith = messageEnds(cancelB, topic, "assistant").at(-1)?.message.stopReason;
  check(endedWith === "aborted", "the run ended aborted on B", endedWith);
  check(messageEnds(cancelA, topic, "assistant").at(-1)?.message.stopReason === "aborted", "the run ended aborted on A");
  check(JSON.stringify(lineNumbers(cancelA, topic)) === JSON.stringify(lineNumbers(cancelB, topic)) && contiguous(lineNumbers(cancelB, topic)), "A and B saw the same partial transcript");
  const cut = lastLine(finalText(cancelB, topic));
  check(cut >= 5 && cut < 2000, "the answer was cut short", cut);
  check(await desktopHasLines(desktop, cut), "the desktop shows the same cut-off answer");
  const afterCancel = (await B.ok("chat.live")).find((c) => c.handle === handle);
  check(afterCancel && afterCancel.running === false, "the host reports the chat idle", afterCancel);
  const sizeAfter = deltas(sseB.events, topic).length;
  await sleep(600);
  check(deltas(sseB.events, topic).length === sizeAfter, "no more output after the cancel");

  // ── Reconnect with Last-Event-ID, idempotent retry ──────────────────────
  log("drop A's stream mid-run, reconnect with Last-Event-ID, retry the prompt with the same key");
  markA = aAll.length;
  markB = sseB.events.length;
  const key = randomUUID();
  const promptArgs = { handle, text: "reconnect test [lines=250][delay=20]", mode: "send" };
  sent = await A.ok("chat.send", promptArgs, { key });
  await until("some lines on A", () => deltas(collectA().slice(markA), topic).length >= 30);
  collectA();
  const lastSeen = sseA.lastId;
  sseA.drop();
  await until("lines to pass while A is away", () => deltas(sseB.events.slice(markB), topic).length >= 90);
  const retry = await A.call("chat.send", promptArgs, { key });
  check(retry.status === 200 && JSON.stringify(retry.value) === JSON.stringify(sent), "the retry with the same Idempotency-Key returns the first result", retry);
  const mismatch = await A.call("chat.send", { ...promptArgs, text: "other text" }, { key });
  check(mismatch.status === 400, "the same key with another body is refused", mismatch.status);
  sseA = A.events([handle], lastSeen);
  await until("A's stream", () => sseA.frames.length > 0);
  check(!sseA.frames.some((f) => f.event === "resync"), "the reconnect replays; it does not resync");
  await until("the run to end on B", () => agentEnds(sseB.events.slice(markB), topic) === 1, 30_000);
  await until("A to catch up", () => agentEnds(sseA.events, topic) === 1);
  collectA();
  const resumed = sseA.events.map((e) => e.seq);
  check(resumed[0] === Number(lastSeen.split(":")[1]) + 1, "A's replay starts right after the last event it had", { first: resumed[0], last: lastSeen });
  const combined = aAll.slice(markA).map((e) => e.seq);
  check(combined.every((n, i) => i === 0 || n === combined[i - 1] + 1), "A's events are contiguous across the drop (no gaps, no duplicates)");
  const reNumbers = lineNumbers(aAll.slice(markA), topic);
  check(reNumbers.length === 250 && contiguous(reNumbers) && reNumbers[0] === 1, "A saw lines 1..250 once each", reNumbers.length);
  check(JSON.stringify(reNumbers) === JSON.stringify(lineNumbers(sseB.events.slice(markB), topic)), "B saw the identical lines");
  const once = userTexts(sseB.events, topic).filter((t) => t.startsWith("reconnect test")).length;
  check(once === 1, "the prompt ran once (retry and mismatch did not add a turn)", once);
  check(!records(sseB.events.slice(markB), topic).some((r) => r.type === "queue_update"), "nothing was queued by the retry");
  await settled(desktop, handle);
  check(await desktopHasLines(desktop, 250), "the desktop shows lines up to 250");

  // ── Ring overflow forces a resync ───────────────────────────────────────
  log("drop A, overflow the ring, reconnect: resync path");
  markA = aAll.length;
  markB = sseB.events.length;
  sent = await A.ok("chat.send", { handle, text: "overflow test [lines=6000][delay=1]", mode: "send" });
  await until("a few lines on A", () => deltas(collectA().slice(markA), topic).length >= 20);
  collectA();
  const oldId = sseA.lastId;
  const oldSeq = Number(oldId.split(":")[1]);
  sseA.drop();
  await until("the ring to overflow", () => (sseB.events.at(-1)?.seq ?? 0) - oldSeq > 2300, 60_000, 100);
  sseA = A.events([handle], oldId);
  await until("A's stream", () => sseA.frames.length > 1);
  const resync = sseA.frames.find((f) => f.event === "resync");
  check(!!resync, "the gap fell out of the ring: the server sends resync", sseA.frames.map((f) => f.event));
  check(!sseA.frames.slice(0, sseA.frames.indexOf(resync)).some((f) => f.event === "host" && f.json.seq <= oldSeq + 1), "no replay of the lost events");
  // The client's resync: replace state from snapshots, then apply only newer events.
  const snap = await A.ok("chat.snapshot", { handle });
  const snapLine = Math.max(...[...JSON.stringify(snap.value).matchAll(/Line (\d+) of the streamed/g)].map((m) => Number(m[1])));
  await until("live events after the snapshot", () => deltas(sseA.events.filter((e) => e.seq > snap.seq), topic).length >= 5);
  const after = lineNumbers(sseA.events.filter((e) => e.seq > snap.seq), topic);
  check(after[0] === snapLine + 1 && contiguous(after), "the snapshot plus newer events leave no gap and no duplicate", { snapLine, first: after[0] });
  const stopped = await A.ok("chat.interrupt", { handle });
  check(Array.isArray(stopped), "A stops the run");
  await until("the run to end", () => agentEnds(sseB.events.slice(markB), topic) === 1 && agentEnds(sseA.events, topic) === 1);
  await settled(desktop, handle);
  collectA();
  const finalSnap = await A.ok("chat.snapshot", { handle });
  const endLine = lastLine(finalText(sseB.events.slice(markB), topic));
  check(Math.max(...[...JSON.stringify(finalSnap.value).matchAll(/Line (\d+) of the streamed/g)].map((m) => Number(m[1]))) === endLine, "the snapshot after the resync ends where B's stream ends", endLine);
  check(await desktopHasLines(desktop, endLine), "the desktop ends at the same line");

  // ── Closing both clients mid-run ────────────────────────────────────────
  log("close A and B mid-run: the run continues");
  markB = sseB.events.length;
  sent = await A.ok("chat.send", { handle, text: "survive test [lines=50][delay=100]", mode: "send" });
  await until("a few lines", () => deltas(sseB.events.slice(markB), topic).length >= 5);
  for (const phone of [A, B]) {
    await phone.call("chat.viewing", { handle, viewing: false });
    await phone.ok("chat.detach", { handle });
  }
  sseA.drop();
  sseB.drop();
  await sleep(800);
  const running = (await desktop.eval("window.studio.liveChats()")).find((c) => c.handle === handle);
  check(running?.running === true, "the run goes on with no phone attached", running);
  await until("the desktop to show the run's end", async () => (await desktopHasLines(desktop, 50)), 30_000, 250);
  check(true, "the desktop saw it finish (line 50)");
  await settled(desktop, handle);
  const idle = (await desktop.eval("window.studio.liveChats()")).find((c) => c.handle === handle);
  check(idle && idle.running === false && idle.settled?.outcome === "done", "the host records the run as done", idle);
  const back = await A.ok("chat.attach", { handle });
  check(back && JSON.stringify(back).includes("Line 50 of the streamed"), "a phone attaching afterwards reads the finished answer");

  await screens(ctx, { handle, A });

  if (flag("--hold")) {
    log(`holding; debug port ${ctx.ports.debug}; Ctrl-C to stop`);
    await new Promise(() => undefined);
  }
}

// ── Desktop helpers ──────────────────────────────────────────────────────────

/** Opens a session from the sidebar, as a click would. */
async function showSession(desktop, title) {
  // A pairing request opens Settings on the Mac; go back to the chat page first.
  await desktop.eval(`[...document.querySelectorAll("button")].find((x) => x.innerText.startsWith("Back to app"))?.click()`);
  await until("the sidebar row", () => desktop.eval(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.startsWith(${JSON.stringify(title)})); if (!b) return false; b.click(); return true; })()`), 20_000, 250);
}
/** The desktop's rendered transcript (or, with `all`, the whole page, which includes approval cards). */
const desktopText = (desktop, all = false) =>
  desktop.eval(all ? "document.body.innerText" : `document.querySelector('div[class*="max-w-[800px]"][class*="gap-10"]')?.innerText ?? ""`);
/** The desktop's last answer (the lines since the last "Line 1") is 1..`last`, each once. */
async function desktopHasLines(desktop, last) {
  const text = await desktopText(desktop);
  const lines = [...text.matchAll(/^Line (\d+) of the streamed/gm)].map((m) => Number(m[1]));
  const answer = lines.slice(lines.lastIndexOf(1));
  return answer.length === last && contiguous(answer) && answer.at(-1) === last;
}
/** The host says the chat is idle and the desktop's store caught up. */
async function settled(desktop, handle) {
  await until("the chat to settle", async () => (await desktop.eval("window.studio.liveChats()")).find((c) => c.handle === handle)?.running === false, 20_000, 100);
  await sleep(600);
}

// ── Mobile screens ───────────────────────────────────────────────────────────

const IPHONE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** What Tailscale serve adds in front of the server, plus A's device cookie, so the mobile app loads paired in a browser tab. */
function startProxy(remotePort, cookie, login) {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${remotePort}`, "tailscale-user-login": login, cookie };
    if (req.method === "POST") headers.origin = `https://127.0.0.1:${remotePort}`;
    const up = http.request({ host: "127.0.0.1", port: remotePort, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => ((res.statusCode = 502), res.end()));
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function screens({ desktop, ports }, { handle, A }) {
  log("mobile screens (iPhone 15 preset in the instance's own browser)");
  proxy = await startProxy(ports.remote, A.cookie, A.login);
  const proxyPort = proxy.address().port;
  const dir = shotsDir ?? join(work, "shots");
  mkdirSync(dir, { recursive: true });
  const inspector = await Cdp.open((await (await fetch(`http://127.0.0.1:${ports.inspect}/json/list`)).json())[0].webSocketDebuggerUrl);
  const mainEval = async (expression) => {
    const result = await inspector.send("Runtime.evaluate", { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`main eval failed: ${result.exceptionDetails.exception?.description}`);
    return result.result.value;
  };
  // A window of the instance itself, rendered offscreen: the instance runs in the background (PIGNA_BACKGROUND=1), where
  // windows and browser tabs draw no frames and cannot be captured (docs/DESIGN.md "Verifying the UI"). Offscreen
  // rendering paints regardless, and the iPhone emulation goes through the same debugger protocol as the browser's.
  await mainEval(`(async () => {
    const { BrowserWindow } = require("electron");
    const win = new BrowserWindow({ show: false, width: ${IPHONE.width}, height: ${IPHONE.height}, webPreferences: { offscreen: true } });
    globalThis.__sliceWin = win;
    win.webContents.setFrameRate(15);
    win.webContents.debugger.attach("1.3");
    await win.loadURL("about:blank");
    return true;
  })()`);
  const view = "globalThis.__sliceWin.webContents";
  const phone = {
    eval: (expression) => mainEval(`${view}.executeJavaScript(${JSON.stringify(expression)})`),
    send: (method, params = {}) => mainEval(`${view}.debugger.sendCommand(${JSON.stringify(method)}, ${JSON.stringify(params)})`),
  };
  await phone.send("Emulation.setDeviceMetricsOverride", { ...IPHONE, screenOrientation: { type: "portraitPrimary", angle: 0 } });
  await phone.send("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA });
  await phone.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await mainEval(`${view}.loadURL("http://127.0.0.1:${proxyPort}/")`);
  const shot = async (name) => {
    await sleep(300);
    const data = await mainEval(`${view}.capturePage().then((image) => image.toPNG().toString("base64"))`);
    writeFileSync(join(dir, `${name}.png`), Buffer.from(data, "base64"));
    log(`  shot ${join(dir, `${name}.png`)}`);
  };
  const text = () => phone.eval("document.body?.innerText ?? ''");
  const tap = (label) => phone.eval(`(() => { const b = [...document.querySelectorAll("button,a,[role=button]")].find((x) => (x.innerText || x.ariaLabel || "").trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);

  if (flag("--debug")) log(`  page ${await phone.eval("location.href")}: ${(await text()).slice(0, 300)}`);
  const present = (needle) => async () => (await text()).includes(needle);
  const exists = (selector) => phone.eval(`!!document.querySelector(${JSON.stringify(selector)})`);

  await until("the projects screen", present("project"), 30_000, 250);
  await sleep(800);
  await shot("1-projects");
  check(await tap("project"), "the phone lists the project");
  await until("the chats screen", present("Earlier question 1"));
  await sleep(800);
  await shot("2-chats");
  check(await tap("Earlier question 1"), "the phone lists the session");
  await until("the chat", () => exists('[data-testid="send"]'));
  await until("the transcript", present("Earlier answer"));
  await sleep(800);
  await shot("3-chat");
  check((await text()).includes("Line 50 of the streamed"), "the phone's chat ends with the last answer of the scenario");

  // The phone's own composer: send a prompt that raises an approval.
  await phone.eval("document.querySelector('textarea').focus()");
  await phone.send("Input.insertText", { text: "phone prompt ask-confirm [lines=300][delay=100]" });
  await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
  await phone.eval(`document.querySelector('[data-testid="send"]').click()`);
  await until("the approval card on the phone", present("Run the fake tool?"));
  check((await text()).includes("Allow") && (await text()).includes("Deny"), "the approval card offers Allow and Deny");
  await sleep(500);
  await shot("4-approval");
  check(await tap("Allow"), "the phone taps Allow");
  await until("the card to go", async () => !(await text()).includes("Run the fake tool?"));
  await until("streamed lines on the phone", present("Line 4 of the streamed"));
  const ph = await A.ok("chat.live");
  check(ph.find((c) => c.handle === handle)?.running === true, "the host shows the phone's prompt running");
  await sleep(500);
  await shot("5-streaming");
  await until("the stop button", () => exists('[data-testid="stop"]'));
  await phone.eval(`document.querySelector('[data-testid="stop"]').click()`);
  await until("the stop confirmation", present("Stop the agent?"));
  await shot("6-stop-confirm");
  await phone.eval(`document.querySelector('[data-testid="confirm-stop"]').click()`);
  await until("the run to stop", async () => !(await exists('[data-testid="stop"]')));
  const stoppedLive = (await A.ok("chat.live")).find((c) => c.handle === handle);
  check(stoppedLive?.running === false, "the host shows the run stopped after the phone's Stop", stoppedLive);
  await sleep(800);
  await shot("7-stopped");
  check(!(await exists('[data-testid="stop"]')), "the phone no longer offers Stop");
  if (flag("--hold")) {
    log(`holding on the mobile page; debug port ${ports.debug}`);
    await new Promise(() => undefined);
  }
  await mainEval(`${view}.debugger.detach(), globalThis.__sliceWin.destroy(), true`);
  inspector.close();
}

let exitCode = 1;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stopInstance().finally(() => process.exit(130)));
try {
  await main();
  exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error(error);
  failures.push(String(error?.message ?? error));
} finally {
  proxy?.close();
  await stopInstance();
  if (!flag("--keep") && failures.length === 0) rmSync(work, { recursive: true, force: true });
  else log(`kept ${work} (app.log inside)`);
}
log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}` : "\nall checks passed");
process.exit(exitCode);
