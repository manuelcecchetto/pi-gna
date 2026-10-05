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
import { deflateSync } from "node:zlib";
import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(project, "notes-alpha.md"), "alpha\n");
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
  seedTools(dir, usage);
  mkdirSync(userData, { recursive: true });
  // Laments for the phone's Laments page: a blocking one hit twice (chat links), a mild one, a resolved one.
  const t = 1791150000000;
  const chat = { path: file, cwd: project };
  writeFileSync(
    join(userData, "laments.json"),
    JSON.stringify({
      version: 1,
      laments: [
        { id: "aaaaaa", title: "No way to record a browser tab", cwd: project, createdAt: t, updatedAt: t + 2000, reports: [{ at: t, text: "First **report** body", severity: "annoying", chat }, { at: t + 2000, text: "Hit again; blocking now", severity: "blocking", chat }] },
        { id: "bbbbbb", title: "Slow grep", cwd: project, createdAt: t, updatedAt: t + 5000, reports: [{ at: t + 5000, text: "Grep took forever", severity: "annoying" }] },
        { id: "cccccc", title: "Old resolved gap", cwd: project, createdAt: t, updatedAt: t + 100, resolvedAt: t + 200, reports: [{ at: t, text: "Was broken", severity: "costly" }] },
      ],
    }),
  );
  // Remote access on through the profile's settings; the server follows them at launch.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ version: 1, remote: { enabled: true, port: ports.remote, keepAwake: "off" } }));
  return file;
}

/** A solid-color PNG (zlib from node), for image blocks; `noise` makes it incompressible (a photo-sized block). */
function png(width, height, [r, g, b], noise = false) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => (noise ? [r, g, b].map((v) => (v + Math.floor(Math.random() * 64)) & 255) : [r, g, b])).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const VISUAL_OK = '<div class="stack"><div class="stat"><span class="stat-value" id="v">42</span><span class="stat-label">answers</span></div></div>';
// Stops the kit's heartbeat without blocking the page: what a wedged frame looks like to the watchdog.
const VISUAL_STUCK = "<div>stuck</div><script>for (let i = 0; i < 99999; i++) clearInterval(i);</script>";

/** A second session with every kind of transcript content the phone's extras handle (tool calls, images, links, visuals). */
function seedTools(dir, usage) {
  const id = "01a20000-0000-7000-8000-000000000003";
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-10-03T08:00:00.000Z", cwd: project }];
  let parent = null;
  let n = 0;
  const entry = (message) => {
    const e = { type: "message", id: `t${String(++n).padStart(3, "0")}xxxxx`, parentId: parent, timestamp: new Date(1791100000000 + n * 1000).toISOString(), message: { ...message, timestamp: 1791100000000 + n * 1000 } };
    lines.push(e);
    parent = e.id;
  };
  const assistant = (content, stopReason) => entry({ role: "assistant", content, api: "fake", provider: "fake", model: "fake", usage, stopReason });
  const tool = (callId, name, args, text, extra = {}) => {
    assistant([{ type: "toolCall", id: callId, name, arguments: args }], "toolUse");
    entry({ role: "toolResult", toolCallId: callId, toolName: name, content: text === undefined ? [] : [{ type: "text", text }], isError: false, ...extra });
  };
  const long = `const veryLongLineOfCode = "${"x".repeat(160)}";`;
  entry({ role: "user", content: [{ type: "text", text: "Tools demo: change the file" }, { type: "image", mimeType: "image/png", data: png(200, 150, [200, 80, 40], true) }] });
  tool("c1", "bash", { command: "ls --color" }, "\u001b[31mred-file\u001b[0m\nplain-file");
  tool("c2", "edit", { path: "src/a.ts" }, "Edited", { details: { diff: ` 1 const a = 1;\n-2 const b = 2;\n+2 ${long}\n 3 export {};` } });
  tool("c3", "read", { path: "notes-alpha.md" }, "alpha");
  tool("c4", "frobnicate", { level: 3, flags: ["x", "y"] }, "frobbed");
  assistant([{ type: "toolCall", id: "c5", name: "screenshot", arguments: {} }], "toolUse");
  entry({ role: "toolResult", toolCallId: "c5", toolName: "screenshot", content: [{ type: "image", mimeType: "image/png", data: png(160, 90, [40, 120, 200]) }], isError: false });
  assistant([{ type: "text", text: `Done. See [the docs](https://example.com/docs).\n\n\`\`\`visual\n${VISUAL_OK}\n\`\`\`\n\n\`\`\`visual\n${VISUAL_STUCK}\n\`\`\`\n` }], "stop");
  entry({ role: "user", content: [{ type: "text", text: "Second turn of the demo" }] });
  assistant([{ type: "text", text: "Second answer." }], "stop");
  // Older than the first session in every sense, so it sorts second and the earlier checks keep opening the first row.
  const file = join(dir, `2026-10-03T08-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  utimesSync(file, new Date("2026-10-03T08:10:00Z"), new Date("2026-10-03T08:10:00Z"));
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
    FAKE_ATP: "1",
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
  let handle = opened.handle;
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

  // ── Two clients at once ─────────────────────────────────────────────────
  log("A and B prompt at the same moment; both edit one card");
  markB = sseB.events.length;
  const both = await Promise.all([
    A.call("chat.send", { handle, text: "concurrent from A [lines=20][delay=40]", mode: "send" }),
    B.call("chat.send", { handle, text: "concurrent from B [lines=20][delay=40]", mode: "send" }),
  ]);
  check(both.every((r) => r.status === 200), "both simultaneous prompts are accepted", both.map((r) => r.status));
  const queuedOf = (events) => events.filter((e) => e.topic === topic && e.event.record?.type === "queue_update").flatMap((e) => [...e.event.record.steering, ...e.event.record.followUp]);
  // The host orders the two: one starts the run, the other lands in pi's queue (nothing is lost or run twice).
  await until("the second prompt to queue", () => queuedOf(sseB.events.slice(markB)).length >= 1);
  const restoredQueue = await B.ok("chat.interrupt", { handle });
  await until("the run to end", () => agentEnds(sseB.events.slice(markB), topic) >= 1, 30_000);
  await settled(desktop, handle);
  const ran = userTexts(sseB.events.slice(markB), topic);
  const queued = queuedOf(sseB.events.slice(markB));
  check(ran.length === 1 && queued.length === 1 && new Set([...ran, ...queued].map((t) => t.slice(0, 20))).size === 2, "one prompt ran, the other waited in the queue, once each", { ran, queued });
  check(restoredQueue.length === 1 && queued[0] === restoredQueue[0], "B's interrupt aborts the run and hands back the waiting message", restoredQueue);

  // board.get answers the bare board for now; the contract wraps global reads as {seq, value}.
  const boardOf = (result) => result.value ?? result;
  const card = randomUUID().replace(/-/g, "").slice(0, 6);
  await A.ok("board.apply", { op: { type: "add", id: card, title: "Shared card", cwd } });
  const baseRev = boardOf(await A.ok("board.get")).rev;
  const edits = await Promise.all([
    A.call("board.apply", { op: { type: "edit", id: card, title: "Title from A" }, baseRev }),
    B.call("board.apply", { op: { type: "edit", id: card, title: "Title from B" }, baseRev }),
  ]);
  const statuses = edits.map((r) => r.status).sort();
  check(statuses[0] === 200 && statuses[1] === 409, "two title edits from one revision: one lands, the other gets a conflict (409)", edits.map((r) => r.status));
  const conflict = edits.find((r) => r.status === 409);
  check((conflict.value?.error?.code ?? conflict.value?.code) === "conflict", "the refused edit says conflict", conflict.value);
  const winner = edits.indexOf(edits.find((r) => r.status === 200)) === 0 ? "Title from A" : "Title from B";
  check(boardOf(await B.ok("board.get")).cards.find((c) => c.id === card)?.title === winner, "the board holds the winner's title", winner);
  const moves = await Promise.all([A.call("board.apply", { op: { type: "move", id: card, column: "done" }, baseRev }), B.call("board.apply", { op: { type: "move", id: card, column: "in_review" }, baseRev })]);
  check(moves.every((r) => r.status === 200), "concurrent moves both succeed (last writer wins)", moves.map((r) => r.status));
  await A.call("board.apply", { op: { type: "remove", id: card } });
  collectA(); // fold this section into A's history before the next one marks its start

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
  check(back && Object.keys(back).join() === "seq", "a phone's attach carries only the seq, not the transcript", back);
  const lastPage = await A.ok("chat.snapshot", { handle, turns: 1 });
  check(JSON.stringify(lastPage).includes("Line 50 of the streamed") && lastPage.value.turns.from === lastPage.value.turns.total - 1, "a phone attaching afterwards reads the finished answer from a one-turn page");

  // ── Host asleep: the process is paused (SIGSTOP on this test instance only), then resumed ──
  log("pause the host process (simulated sleep), then resume");
  const sleeper = A.events([handle]);
  await until("the sleeper stream", () => sleeper.frames.some((f) => f.event === "hello"));
  markB = sleeper.events.length;
  await A.ok("chat.send", { handle, text: "sleep test [lines=40][delay=150]", mode: "send" });
  await until("a few lines before the pause", () => deltas(sleeper.events.slice(markB), topic).length >= 5);
  process.kill(instance.pid, "SIGSTOP");
  let paused = true;
  try {
    const beforePause = sleeper.events.length;
    const hung = await Promise.race([A.call("chat.live", {}).then(() => false, () => true), sleep(3000).then(() => true)]);
    check(hung, "a call to the paused host gets no answer (the client's timeout/unreachable path)");
    await sleep(1500);
    check(sleeper.events.length - beforePause <= 1 && !sleeper.closed, "no events arrive while paused and the stream is not torn down by the host", sleeper.events.length - beforePause);
  } finally {
    process.kill(instance.pid, "SIGCONT");
    paused = false;
  }
  check(paused === false, "the host process resumed");
  await until("the run to finish after resume", () => agentEnds(sleeper.events.slice(markB), topic) === 1, 40_000, 100);
  const slept = lineNumbers(sleeper.events.slice(markB), topic);
  check(slept.length === 40 && contiguous(slept) && slept[0] === 1, "after resume the same stream carries lines 1..40 once each", slept.length);
  check((await A.call("chat.live", {})).status === 200, "calls answer again after resume");
  sleeper.drop();

  await screens(ctx, { handle, A });
  // The phone checks close the chat (Close chat in the sheet): the sections below need it live again.
  handle = (await A.ok("chat.open", { request: { cwd, sessionPath: sessionFile } })).handle;

  // ── Host restart: new bootId, old idempotency keys, resync ──────────────
  log("restart the host: new boot id");
  const hello = (await A.json("GET", "/api/hello")).value;
  const oldBoot = hello.bootId;
  const bootCursor = `${oldBoot}:${(await A.ok("chat.snapshot", { handle })).seq}`;
  const turnsBefore = JSON.stringify((await A.ok("chat.snapshot", { handle })).value).split("restart test").length - 1;
  desktop.close();
  await stopInstance();
  instance = launch(ctx.ports);
  await until("the remote server after restart", async () => (await request(ctx.ports.remote, { path: "/api/hello", headers: A.headers() }).catch(() => ({ status: 0 }))).status === 200, 40_000, 250);
  const again = (await A.json("GET", "/api/hello")).value;
  check(again.authenticated === true, "the paired device survives the restart (same cookie)");
  check(again.bootId !== undefined && again.bootId !== oldBoot, "the host has a new boot id", { oldBoot, new: again.bootId });
  const stale = await A.call("chat.send", { handle, text: "restart test", mode: "send" }, { key: "old-key", boot: oldBoot });
  check(stale.status === 409 && stale.value?.error?.code === "host_restarted", "an old key sent with the old boot id fails host_restarted", stale);
  const liveAfter = await A.ok("chat.live", {});
  check(!liveAfter.some((c) => c.handle === handle), "no chat was started by the stale prompt");
  const resyncStream = A.events([handle], bootCursor);
  await until("the restarted stream", () => resyncStream.frames.length > 1);
  const r = resyncStream.frames.find((f) => f.event === "resync");
  check(r?.json.reason === "new_boot" && resyncStream.frames.indexOf(r) === 1 && resyncStream.frames[0].event === "hello", "a stream resuming an old boot gets resync(new_boot) right after hello, before any replay", resyncStream.frames.map((f) => f.event));
  resyncStream.drop();
  const reopened = await A.ok("chat.open", { request: { cwd: ctx.project, sessionPath: sessionFile } });
  check(JSON.stringify(reopened).split("restart test").length - 1 === turnsBefore, "reopening after the restart shows the transcript without the stale prompt");
  await A.call("chat.close", { handle: reopened.handle ?? handle });

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
    if (req.method === "POST" || req.method === "PUT") headers.origin = `https://127.0.0.1:${remotePort}`;
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
  await until("the transcript", present("Line 50 of the streamed"));
  await sleep(800);
  await shot("3-chat");
  check(true, "the phone's chat ends with the last answer of the scenario");
  // It opens on the last few turns; scrolling to the top pages the earlier ones in, with no button to tap.
  check(!(await text()).includes("Earlier answer 1."), "the chat opens on a short first page");
  await until("the earliest turn after scrolling up", async () => {
    await phone.eval(`(() => { const s = [...document.querySelectorAll('.overflow-y-auto')].find((e) => e.scrollHeight > e.clientHeight && e.innerText.includes('streamed')); if (s) { s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); } })()`);
    return (await text()).includes("Earlier answer 1.");
  }, 20_000, 300);
  check(true, "scrolling to the top loads the earlier turns");
  await phone.eval(`(() => { const s = [...document.querySelectorAll('.overflow-y-auto')].find((e) => e.scrollHeight > e.clientHeight && e.innerText.includes('streamed')); if (s) s.scrollTop = s.scrollHeight; })()`);

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
  await followChecks({ phone, present });
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
  await composerChecks({ phone, A, handle, shot, text, tap, exists, present });
  await projectChecks({ phone, A, handle, shot, text, exists, present });
  await boardChecks({ phone, A, shot, text, exists, present });
  await lamentChecks({ phone, A, shot, text, exists, present });
  await githubChecks({ phone, A, shot, text, exists });
  await atpChecks({ phone, A, shot, text, exists, present });
  await settingsChecks({ phone, A, shot, text, exists, present });
  await transcriptChecks({ phone, A, shot, text, tap, exists, present });
  await browserChecks({ phone, A, shot, text, tap, exists, present });
  if (flag("--hold")) {
    log(`holding on the mobile page; debug port ${ports.debug}`);
    await new Promise(() => undefined);
  }
  await mainEval(`${view}.debugger.detach(), globalThis.__sliceWin.destroy(), true`);
  inspector.close();
}

/** While the phone's prompt streams: at the end the view follows it, and the jump-to-latest button shows exactly when it does not. */
async function followChecks({ phone, present }) {
  log("mobile streaming follow");
  const scroller = `[...document.querySelectorAll('.overflow-y-auto')].find((e) => e.innerText.includes('streamed'))`;
  const end = () => phone.eval(`(() => { const s = ${scroller}; return s.scrollHeight - s.scrollTop - s.clientHeight; })()`);
  const bubble = () => phone.eval(`!!document.querySelector('button[title="Jump to latest"]')`);
  const touch = (type, points) => phone.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  await until("the answer to outgrow the view", present("Line 40 of the streamed"));
  await sleep(1000);
  check((await end()) <= 2 && !(await bubble()), "the phone follows the streaming answer at the end", await end());

  // iOS's rubber band: pulled past the end, the view bounces back up to it. Chromium cannot overscroll, so replay those offsets.
  await phone.eval(`(async () => {
    const s = ${scroller};
    for (const past of [30, 15, 5, 0]) {
      const top = s.scrollHeight - s.clientHeight + past;
      Object.defineProperty(s, "scrollTop", { configurable: true, get: () => top, set: () => undefined });
      s.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    delete s.scrollTop;
    return true;
  })()`);
  await sleep(2000);
  check((await end()) <= 2 && !(await bubble()), "after a bounce at the end the phone still follows", await end());

  // A finger dragging the transcript down scrolls up: following stops and the button shows.
  const box = await phone.eval(`(() => { const r = (${scroller}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; })()`);
  await touch("touchStart", [[box.x, box.y]]);
  for (let step = 1; step <= 6; step++) {
    await touch("touchMove", [[box.x, box.y + step * 40]]);
    await sleep(30);
  }
  await touch("touchEnd", []);
  await sleep(1500);
  const left = await end();
  check(left > 2 && (await bubble()), "scrolling up stops following and shows the jump-to-latest button", left);
  await sleep(1000);
  check((await end()) > left, "the answer streams on below without pulling the view down");
  await phone.eval(`document.querySelector('button[title="Jump to latest"]').click()`);
  await sleep(2000);
  check((await end()) <= 2 && !(await bubble()), "Jump to latest follows the stream again", await end());
}

/** The phone's browser screen (T36): drive a local dev page in the instance's own browser with the iPhone preset, the instance's window hidden. */
async function browserChecks({ phone, A, shot, text, tap, exists, present }) {
  log("mobile browser screen");
  const hits = [];
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/hit") {
      hits.push([url.searchParams.get("k"), url.searchParams.get("v")]);
      return res.end("ok");
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Dev page</title><body style="margin:0;height:4000px">
<button id=b style="position:fixed;left:100px;top:200px;width:160px;height:80px">tap me</button>
<input id=i style="position:fixed;left:20px;top:320px;width:300px;height:40px">
<script>const hit=(k,v)=>fetch('/hit?k='+k+'&v='+encodeURIComponent(v||''));
b.onclick=()=>hit('click');i.oninput=()=>hit('input',i.value);addEventListener('keydown',e=>hit('key',e.key));addEventListener('scroll',()=>hit('scroll',scrollY));</script>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const hit = (k) => hits.filter(([key]) => key === k);
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const touch = (type, points) => phone.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const rect = () => phone.eval(`(() => { const r = document.querySelector('[data-testid="frame"]')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; })()`);
  const onFrame = async (cssX, cssY) => {
    const r = await rect();
    return [r.left + (cssX / 393) * r.width, r.top + (cssY / 852) * r.height];
  };
  const tapPage = async (cssX, cssY) => {
    const [x, y] = await onFrame(cssX, cssY);
    await touch("touchStart", [[x, y]]);
    await touch("touchEnd", []);
  };
  const typeInto = async (testId, t) => {
    await phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); e.focus(); e.select(); })()`);
    await phone.send("Input.insertText", { text: t });
  };

  try {
    await phone.eval("location.href = '/'");
    await until("the projects screen", () => exists('[data-testid="open-browser"]'), 30_000, 250);
    await A.ok("browser.newTab", { url });
    check(await click("open-browser"), "the projects screen opens the browser");
    await until("the tab", async () => (await text()).includes("Dev page"), 20_000, 100);
    check(!(await exists('[data-testid="window-badge"]')), "a pane tab is not marked as a window");
    await click("viewport-open");
    await until("the viewport sheet", () => exists('[data-testid="viewport-sheet"]'));
    check(await phone.eval(`(() => { const e = [...document.querySelectorAll('[data-testid="viewport-option"]')].find((x) => x.innerText.includes("iPhone 15")); if (!e) return false; e.click(); return true; })()`), "the viewport sheet offers the iPhone 15 preset");
    await until("the viewport on the host", async () => (await A.ok("browser.state")).tabs.some((t) => t.viewport?.label === "iPhone 15"));
    check(true, "the host tab runs the iPhone 15 viewport");
    await until("the frame", () => phone.eval(`(() => { const i = document.querySelector('[data-testid="frame"]'); return !!i && i.complete && i.naturalWidth > 0; })()`), 30_000, 200);
    await sleep(800);
    await shot("browser-1-frame");
    check(true, "the stream draws a frame of the page with the instance's window hidden");

    await tapPage(180, 240);
    await until("the tap to land", async () => hit("click").length > 0, 10_000, 100);
    check(true, "a tap on the frame clicks the page's button on the host");

    await tapPage(100, 340);
    await sleep(500);
    await typeInto("type-field", "hello");
    await click("type-send");
    await until("the typed text", async () => hit("input").some(([, v]) => v === "hello"), 10_000, 100);
    check(true, "the text field types into the focused input");
    await click("keys-open");
    await until("the keys sheet", () => exists('[data-testid="key-Enter"]'));
    await click("key-Enter");
    await until("the Enter key", async () => hit("key").some(([, v]) => v === "Enter"), 10_000, 100);
    check(true, "a key button sends the key to the page");
    await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);

    const [fx, fy] = await onFrame(196, 500);
    await touch("touchStart", [[fx, fy]]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[fx, fy - i * 25]]);
      await sleep(40);
    }
    await touch("touchEnd", []);
    await until("the page to scroll", async () => hit("scroll").some(([, v]) => Number(v) > 100), 10_000, 100);
    check(true, "dragging on the frame scrolls the page", hit("scroll"));

    const [cx, cy] = await onFrame(196, 426);
    await touch("touchStart", [[cx - 20, cy], [cx + 20, cy]]);
    for (let i = 1; i <= 6; i++) {
      await touch("touchMove", [[cx - 20 - i * 10, cy], [cx + 20 + i * 10, cy]]);
      await sleep(30);
    }
    await touch("touchEnd", []);
    await until("the zoom", () => exists('[data-testid="zoom-reset"]'));
    check((await phone.eval(`new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="frame"]')).transform).a`)) > 1.5, "two fingers zoom the picture locally");
    await shot("browser-2-zoomed");
    await click("zoom-reset");
    check(!(await exists('[data-testid="zoom-reset"]')), "the reset button restores the fit");

    // Address bar with history suggestions, then reload.
    await typeInto("address", "127.0");
    await until("a suggestion", () => exists('[data-testid="suggestion"]'));
    check(true, "the address bar suggests visited pages");
    await phone.eval(`document.querySelector('[data-testid="address"]').blur()`);
    await click("nav-reload");

    // Comment mode.
    await click("comment-mode");
    await sleep(300);
    await tapPage(180, 240);
    await until("the comment sheet", () => exists('[data-testid="comment-sheet"]'));
    await typeInto("comment-text", "make this bigger");
    await click("comment-add");
    await until("the annotation chip", () => exists('[data-testid="annotation-chip"]'), 20_000, 100);
    check(true, "comment mode turns a tap into an annotation chip");
    await shot("browser-3-comment");
    await click("comment-mode");

    // The chip rides with this phone's next prompt.
    await phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
    await until("the projects screen", () => exists('[data-testid="open-browser"]'));
    check(await tap("project"), "back on the projects list");
    await until("the chats screen", present("Earlier question 1"));
    await tap("Earlier question 1");
    await until("the composer", () => exists('[data-testid="send"]'));
    check(await exists('[data-testid="annotation-chip"]'), "the composer shows the comment chip");
    await phone.eval("document.querySelector('textarea').focus()");
    await phone.send("Input.insertText", { text: "echo-attach zzcomment" });
    await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
    await phone.eval(`document.querySelector('[data-testid="send"]').click()`);
    await until("the host's echo", async () => /zzcomment[^]*\[images=\d\]/.test(await text()), 30_000, 200);
    const echoed = await text();
    check((() => { const tail = echoed.slice(echoed.indexOf("zzcomment")); return tail.includes("Browser comments (1)") && tail.includes("[images=1]"); })(), "the host composed the comment and its crop into the prompt", echoed.slice(-300));
    check(!(await exists('[data-testid="annotation-chip"]')), "the chip is gone once the prompt was taken");
  } finally {
    fixture.close();
  }
}

/** The phone's ATP page (T32): plans, nodes, graph gestures, start / stop / resume on the host, the orchestrator and a new plan. */
async function atpChecks({ phone, A, shot, text, exists, present }) {
  log("mobile ATP");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const node = (id, status, extra = {}) => ({ title: `Node ${id}`, instruction: `Instruction **${id}**`, dependencies: [], status, ...extra });
  const planFile = join(project, "docs", "plans", "draft", "mini.atp.json");
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, JSON.stringify({ meta: { project_name: "Mini plan", version: "1.3", project_status: "DRAFT" }, nodes: { A: node("A", "READY"), B: node("B", "LOCKED", { dependencies: ["A"] }), C: node("C", "LOCKED", { dependencies: ["B"] }) } }, null, 2));
  const planNodes = async () => Object.fromEntries((await A.ok("atp.read", { plan: planFile })).nodes.map((n) => [n.id, n.status]));
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("the project sheet", () => exists('[data-testid="act-atp"]'));
  await click("act-atp");
  await until("the plan", () => exists('[data-testid="plan-bar"]'));
  const body = await text();
  check(body.includes("Mini plan") && body.includes("DRAFT") && /0\/3/.test(body), "the plan bar shows the plan, its status and 0/3");
  check(await exists('[data-testid="start"]'), "a draft plan offers Start");
  check((await exists('[data-testid="group-ready"]')) && (await exists('[data-testid="group-locked"]')) && !(await exists('[data-testid="group-done"]')), "the node list is grouped by status");
  await shot("31-atp-nodes");

  await phone.eval(`document.querySelector('[data-testid="node-row"][data-node="B"]').click()`);
  await until("the node sheet", () => exists('[data-testid="node-sheet"]'));
  check((await phone.eval(`!!document.querySelector('[data-testid="node-instruction"] strong')`)) && (await text()).includes("Depends on"), "a node opens to its instruction (as Markdown) and its dependencies");
  await shot("32-atp-node");
  await phone.eval(`document.querySelector('[data-testid="node-sheet"] [aria-label="Close"]').click()`);

  // The graph: nodes as cards, a two-finger pinch zooms and a one-finger drag pans (pointer events).
  await click("tab-graph");
  await until("the graph", async () => (await phone.eval(`document.querySelectorAll("[data-node]").length`)) >= 3);
  await sleep(300);
  const layerOf = () => phone.eval(`(() => { const l = document.querySelector(".atp-layer"); const m = new DOMMatrix(getComputedStyle(l).transform); return { k: m.a, x: m.e, y: m.f }; })()`);
  const before = await layerOf();
  const fire = (type, id, x, y) => phone.eval(`(() => { const t = type => ${JSON.stringify(type)}; const v = document.querySelector(".atp-layer").parentElement; const e = new PointerEvent(${JSON.stringify(type)}, { pointerId: ${id}, button: 0, clientX: ${x}, clientY: ${y}, bubbles: true, pointerType: "touch" }); (${JSON.stringify(type)} === "pointerdown" ? v : window).dispatchEvent(e); })()`);
  await fire("pointerdown", 1, 150, 300);
  await fire("pointerdown", 2, 250, 300);
  await fire("pointermove", 2, 350, 300);
  await fire("pointerup", 2, 350, 300);
  await fire("pointerup", 1, 150, 300);
  const pinched = await layerOf();
  check(pinched.k > before.k * 1.5, "a two-finger pinch zooms the graph in", { before, pinched });
  await fire("pointerdown", 3, 200, 300);
  await fire("pointermove", 3, 260, 340);
  await fire("pointerup", 3, 260, 340);
  const panned = await layerOf();
  check(Math.abs(panned.x - pinched.x - 60) < 2 && Math.abs(panned.y - pinched.y - 40) < 2 && Math.abs(panned.k - pinched.k) < 1e-6, "a one-finger drag pans without zooming", { pinched, panned });
  await shot("33-atp-graph");
  await click("tab-nodes");

  // Run it from the phone: start, watch, stop, resume.
  await click("start");
  await until("the host to run the plan", async () => Object.keys((await A.ok("atp.state")).runners ?? {}).includes(planFile), 20_000);
  await until("the run on the phone", () => exists('[data-testid="runner"]'));
  check(!(await exists('[data-testid="start"]')) && (await exists('[data-testid="stop"]')), "while it runs the plan bar offers Stop, not Start");
  await until("the first node to finish", async () => (await planNodes()).A === "COMPLETED", 30_000);
  await until("it on the phone", () => exists('[data-testid="group-done"]'));
  check(true, "the phone's node list moves finished nodes to Done as the run goes");
  await shot("34-atp-running");
  await click("stop");
  await until("the run to stop", async () => !Object.keys((await A.ok("atp.state")).runners ?? {}).includes(planFile), 20_000);
  await until("Run on the phone", () => exists('[data-testid="start"]'));
  check(/Run|Resume/.test(await phone.eval(`document.querySelector('[data-testid="start"]').innerText`)), "after Stop the phone offers to run the plan again");
  await shot("35-atp-stopped");
  await click("start");
  await until("the plan to finish", async () => Object.values(await planNodes()).every((status) => status === "COMPLETED"), 60_000);
  await until("3/3 on the phone", present("3/3"), 20_000);
  await until("the run to end on the phone", async () => !(await exists('[data-testid="stop"]')), 20_000);
  check(!(await exists('[data-testid="start"]')), "a finished plan offers neither Start nor Stop");
  await shot("36-atp-finished");

  // The orchestrator is a full chat screen; leaving it gives the host its chat back.
  await click("orchestrator");
  await until("the orchestrator chat", () => exists('[data-testid="send"]'));
  check(Object.keys((await A.ok("atp.state")).orchestrators ?? {}).includes(planFile), "the orchestrator chat runs on the host for the plan");
  await tapBack();
  await until("the plan again", () => exists('[data-testid="plan-bar"]'));
  await until("the host to let the idle orchestrator go", async () => !Object.keys((await A.ok("atp.state")).orchestrators ?? {}).includes(planFile), 15_000);
  check(true, "leaving the orchestrator chat releases it on the host");

  // A new plan: the architect's chat opens with its skill typed in the composer.
  await click("new-plan");
  await until("the architects", () => exists('[data-testid="architect-atp-architect"]'));
  await shot("37-atp-new-plan");
  await click("architect-atp-architect");
  await until("the architect chat", () => exists('[data-testid="send"]'));
  check((await phone.eval(`document.querySelector("textarea").value`)).startsWith("/skill:atp-architect"), "a new plan opens the architect with its skill in the composer");
  await tapBack();
  await until("the plan once more", () => exists('[data-testid="plan-bar"]'));
}

/** The phone's GitHub page (T31): the no-remote problem, then a public repository's issues and PRs through the host's gh (read-only). */
async function githubChecks({ phone, A, shot, text, exists }) {
  log("mobile github parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const openPage = async () => {
    for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
      await tapBack();
      await sleep(400);
    }
    await until("the projects screen", () => exists('[data-testid="open-settings"]'));
    await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await until("the project sheet", () => exists('[data-testid="act-github"]'));
    await click("act-github");
    await until("the github page", () => exists('[data-testid="github-screen"]'));
  };
  await openPage();
  await until("the no-remote problem", () => exists('[data-testid="github-problem"]'));
  check(/GitHub remote|remote/i.test(await text()), "a project without a GitHub remote shows the problem as on the desktop");
  await shot("24-github-problem");
  spawnSync("git", ["remote", "add", "origin", "https://github.com/cli/cli.git"], { cwd: project });
  await click("github-refresh");
  await until("the page asks again", async () => !(await text()).includes("has no GitHub remote"));
  await until("issues or a problem", async () => (await exists('[data-testid="github-item"]')) || (await exists('[data-testid="github-empty"]')) || (await exists('[data-testid="github-problem"]')));
  await sleep(600);
  await shot("25-github-list");
  if (await exists('[data-testid="github-item"]')) {
    check((await text()).includes("Pull requests") && (await exists('[data-testid="github-account"]')), "tabs and the account chooser show");
    await click("github-row");
    await until("the body", () => exists('[data-testid="github-detail"]'));
    await click("github-actions");
    await until("the sheet", () => exists('[data-testid="github-sheet"]'));
    const sheetText = await text();
    check(["Open on GitHub", "Copy link", "New card from it", "Link to card"].every((l) => sheetText.includes(l)), "the actions sheet offers open, copy, card and link");
    await shot("26-github-sheet");
    const before = (await A.ok("board.get")).cards.length;
    await click("action-new-card");
    await until("a card made from the item", async () => (await A.ok("board.get")).cards.length === before + 1);
    check(true, "New card from it adds a linked card on the host");
  } else {
    check(true, "no issues readable here (no gh or no access): the problem or empty state shows");
  }
  spawnSync("git", ["remote", "remove", "origin"], { cwd: project });
}

/** The phone's projects and chats (T25): search, long-press sheets, pins, board, close, folder browser, feature switches. */
async function projectChecks({ phone, A, handle, shot, text, exists, present }) {
  log("mobile projects and chats parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const longPress = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const type = async (testId, t) => {
    await phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); e.focus(); e.select(); })()`);
    await phone.send("Input.insertText", { text: t });
  };

  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));
  await sleep(500);
  await shot("8-chats-list");
  await type("search", "zzzzqq");
  await until("no chat matches", present("No chat matches."));
  await type("search", "Earlier");
  await until("the chat again", async () => (await count("chat-row")) > 0);
  check(true, "the chat search filters by title");

  // Long-press a live chat: Open, board, Close chat, Copy path.
  check(await longPress("chat-row"), "a long press opens the chat sheet");
  await until("the chat sheet", () => exists('[data-testid="chat-sheet"]'));
  const sheet = await text();
  check(["Open", "Add to the board", "Close chat", "Copy path"].every((l) => sheet.includes(l)), "the chat sheet offers Open, Add to the board, Close chat and Copy path", sheet.slice(0, 300));
  await shot("9-chat-sheet");
  await click("act-add-board");
  await until("the card on the host", async () => ((await A.ok("board.get")).cards ?? []).length > 0);
  check(true, "Add to the board puts the chat on the board");
  await sleep(500);
  await longPress("chat-row");
  await until("the sheet again", () => exists('[data-testid="chat-sheet"]'));
  check((await text()).includes("Show on the board"), "after adding, the sheet offers Show on the board");
  await click("act-show-board");
  await until("the board page", () => exists('[data-testid="board-screen"]'));
  check(await exists('[data-testid="card-page"]'), "Show on the board opens that card");
  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));

  // Kanban off: no board rows.
  const settings = await A.ok("settings.get");
  await A.ok("settings.apply", { op: { type: "feature", feature: "kanban", enabled: false }, baseRev: settings.rev });
  await sleep(600);
  await longPress("chat-row");
  await until("the sheet", () => exists('[data-testid="chat-sheet"]'));
  const quiet = await text();
  check(!(await exists('[data-testid="act-add-board"]')) && !(await exists('[data-testid="act-show-board"]')) && quiet.includes("Close chat"), "with Kanban off the chat sheet has no board row", quiet.slice(0, 300));
  await click("act-open");
  await until("the chat", () => exists('[data-testid="send"]'));
  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));
  const settings2 = await A.ok("settings.get");
  await A.ok("settings.apply", { op: { type: "feature", feature: "kanban", enabled: true }, baseRev: settings2.rev });

  // Close chat asks first, then stops pi.
  await longPress("chat-row");
  await until("the sheet", () => exists('[data-testid="chat-sheet"]'));
  await click("act-close");
  await until("the confirmation", () => exists('[data-testid="confirm-close"]'));
  await shot("10-close-confirm");
  check((await A.ok("chat.live")).some((c) => c.handle === handle), "before confirming, the chat is still live");
  await click("confirm-close-go");
  await until("the chat to close on the host", async () => !(await A.ok("chat.live")).some((c) => c.handle === handle));
  check(true, "confirming Close chat stops the chat on the host");

  // Projects: search, pin, long-press sheet, folder browser.
  await tapBack();
  await until("the projects screen", () => exists('[data-testid="open-folder"]'));
  await sleep(500);
  await shot("11-projects");
  await longPress("project-row");
  await until("the project sheet", () => exists('[data-testid="project-sheet"]'));
  const psheet = await text();
  check(["New chat", "Pin project", "Kanban board", "Copy path"].every((l) => psheet.includes(l)), "the project sheet offers New chat, Pin project, Kanban board and Copy path", psheet.slice(0, 300));
  await shot("12-project-sheet");
  await click("act-pin");
  await until("the pin on the host", async () => (await A.ok("ui.get")).pins.length === 1);
  check(true, "Pin project is saved on the host");
  await sleep(500);
  check(await phone.eval(`!!document.querySelector('[data-testid="project-row"] svg.lucide-pin')`), "the pinned project shows its pin");
  await shot("13-pinned");
  await type("search", "nothing-like-this-zz");
  await until("no match", present("No project matches."));
  await type("search", "");

  await click("open-folder");
  await until("the folder picker", () => exists('[data-testid="folder-picker"]'));
  await until("folders", async () => (await count("host-folder")) > 0);
  await shot("14-folder-picker");
  const before = await count("host-folder");
  await click("toggle-hidden");
  await until("hidden folders", async () => (await count("host-folder")) >= before);
  await shot("15-folder-picker-hidden");
  await click("open-this-folder");
  await until("a new chat", () => exists('[data-testid="send"]'));
  check(true, "opening a folder starts a new chat there");
  await shot("16-new-chat");
}

/** The phone's Kanban board (T29): columns with counts, card sheet edits with conflicts, moves, drag reorder, add card with a photo, task chats. */
async function boardChecks({ phone, A, shot, text, exists, present }) {
  log("mobile board parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const titles = () => phone.eval(`[...document.querySelectorAll('[data-testid="card-row"] span.flex-1')].map((e) => e.innerText)`);
  const tabCounts = () => phone.eval(`Object.fromEntries([...document.querySelectorAll('[role=tab]')].map((e) => [e.dataset.testid, e.querySelector('[data-testid=column-count]').innerText]))`);
  const card = async (id) => (await A.ok("board.get")).cards.find((c) => c.id === id);
  const typeInto = async (testId, t) => {
    await phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); e.focus(); e.select?.(); })()`);
    await phone.send("Input.insertText", { text: t });
  };
  const blur = () => phone.eval("document.activeElement?.blur()");

  const existing = (await A.ok("board.get")).cards[0];
  const cwd = existing.cwd;
  const seeded = [
    { id: "bdone1", title: "Seeded first card", tags: ["ui", "mobile"], column: "todo", notes: "Needs **bold** notes" },
    { id: "bdone2", title: "Seeded second card", column: "todo", github: [{ kind: "issue", host: "github.com", repo: "o/r", number: 12, url: "https://github.com/o/r/issues/12", title: "An issue" }] },
    { id: "bdone3", title: "Seeded third card", column: "todo" },
    { id: "bdone4", title: "Seeded review card", column: "in_review" },
  ];
  for (const op of seeded) await A.ok("board.apply", { op: { type: "add", cwd, before: null, ...op } });
  await A.ok("board.apply", { op: { type: "report", id: "bdone4", text: "Checked and works", column: "in_review" } });

  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("the project sheet", () => exists('[data-testid="act-board"]'));
  await click("act-board");
  await until("the board", () => exists('[data-testid="board-screen"]'));
  await until("the todo cards", async () => (await count("card")) === 3);
  const counts = await tabCounts();
  check(counts["column-todo"] === "3" && counts["column-in_review"] === "1" && counts["column-in_progress"] === "1", "the segmented control carries each column's count", counts);
  const first = await phone.eval(`document.querySelector('[data-testid="card-row"]').innerText`);
  check(first.includes("ui") && first.includes("mobile"), "a card row shows its tags", first);
  check((await count("github-badge")) === 1 && (await phone.eval(`document.querySelector('[data-testid=github-badge]').innerText`)).includes("12"), "a card row shows its GitHub badge");
  await shot("23-board");

  // Marks and counts of a card with a chat: the in-progress card is the chat added from the Chats screen.
  await click("column-in_progress");
  await until("the in-progress card", async () => (await count("card")) === 1);
  check((await count("chat-count")) === 1, "a card with an attached chat shows the chat count");
  await click("column-todo");

  // Card page: edit title/notes, tags, conflicts.
  await until("todo cards", async () => (await count("card")) === 3);
  await phone.eval(`document.querySelector('[data-testid="card-row"]').click()`);
  await until("the card page", () => exists('[data-testid="card-page"]'));
  check((await phone.eval(`!!document.querySelector('[data-testid="card-notes"] strong')`)), "notes render as Markdown");
  await shot("24-card-page");
  await typeInto("card-title", "Renamed on the phone");
  await blur();
  await until("the title on the host", async () => (await card("bdone1"))?.title === "Renamed on the phone");
  check(true, "editing the title saves it on the host");
  await click("card-notes");
  await until("the notes editor", () => exists('[data-testid="card-notes-edit"]'));
  await typeInto("card-notes-edit", "Phone notes");
  await blur();
  await until("the notes on the host", async () => (await card("bdone1"))?.notes === "Phone notes");
  check(true, "editing the notes saves them on the host");

  // A host edit lands while the phone has an unsaved edit: refused, the phone shows the host's text.
  await typeInto("card-title", "Phone draft");
  await A.ok("board.apply", { op: { type: "edit", id: "bdone1", title: "Host wins" } });
  await sleep(300);
  await typeInto("card-title", "Phone draft two");
  await blur();
  await sleep(800);
  check((await card("bdone1"))?.title === "Host wins", "a stale title edit does not overwrite the host's", (await card("bdone1"))?.title);
  check((await phone.eval(`document.querySelector('[data-testid="card-title"]').value`)) === "Host wins", "the card page shows the host's text after a conflict");

  await typeInto("tag-input", "Extra Tag");
  await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await until("the tag on the host", async () => (await card("bdone1"))?.tags.includes("extra-tag"));
  await phone.eval(`document.querySelector('[aria-label="Remove ui"]').click()`);
  await until("the tag gone", async () => !(await card("bdone1"))?.tags.includes("ui"));
  check(true, "tags are added and removed on the host");
  check((await tapBackIfPage(phone)) === true, "closing the card page returns to the board");

  // GitHub links: unlink a seeded one; a link that gh cannot find shows its problem.
  await until("the cards", async () => (await count("card")) === 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card-row"]')].find((e) => e.innerText.includes("second")).click()`);
  await until("the card page", () => exists('[data-testid="card-github"]'));
  check((await count("card-github-ref")) === 1, "the card page lists its GitHub links");
  await typeInto("link-input", "zz-not-an-issue");
  await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await until("a lookup problem", () => exists('[data-testid="link-error"]'), 30_000);
  check(true, "linking something that is not an issue or PR shows the lookup problem");
  await click("unlink");
  await until("the unlink on the host", async () => (await card("bdone2"))?.github.length === 0);
  check(true, "Unlink removes the link on the host");
  await shot("25-card-github");
  await tapBackIfPage(phone);

  // Move to…
  await until("the cards", async () => (await count("card")) === 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card"]')].find((e) => e.innerText.includes("third")).querySelector('[data-testid="card-actions"]').click()`);
  await until("the card menu", () => exists('[data-testid="card-menu"]'));
  const menu = await text();
  check(menu.includes("Investigate") && menu.includes("Resolve") && !menu.includes("QA"), "the card menu offers Investigate and Resolve, QA only in review", menu.slice(0, 200));
  await shot("26-card-menu");
  await click("move-in_progress");
  await until("the move on the host", async () => (await card("bdone3"))?.column === "in_progress");
  check(true, "Move to… moves the card on the host");

  // Reorder by long-press drag: the first todo card drops below the second.
  await until("two todo cards", async () => (await count("card")) === 2);
  const before = await titles();
  const rect = (i) => phone.eval(`(() => { const r = document.querySelectorAll('[data-testid="card-row"]')[${i}].getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2, h: r.height }; })()`);
  const r0 = await rect(0);
  const r1 = await rect(1);
  await phone.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r0.x, y: r0.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await sleep(700);
  for (let step = 1; step <= 6; step++) {
    await phone.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r0.x, y: r0.y + ((r1.y - r0.y + r1.h) * step) / 6, buttons: 1 });
    await sleep(40);
  }
  await phone.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r0.x, y: r1.y + r1.h, button: "left", buttons: 0, clickCount: 1 });
  await until("the order on the host", async () => {
    const todo = (await A.ok("board.get")).cards.filter((c) => c.cwd === cwd && c.column === "todo").map((c) => c.id);
    return todo[0] === "bdone2" && todo[1] === "bdone1";
  }, 8000).catch(() => undefined);
  const todoNow = (await A.ok("board.get")).cards.filter((c) => c.cwd === cwd && c.column === "todo").map((c) => c.id);
  check(todoNow[0] === "bdone2" && todoNow[1] === "bdone1", "a long-press drag reorders the column on the host", { before, todoNow });
  check(!(await exists('[data-testid="card-page"]')), "the drag does not open the card");

  // Add card with a photo.
  const photo = png(40, 40, [200, 40, 40]).toString("base64");
  await click("add-card");
  await until("the add sheet", () => exists('[data-testid="add-card-sheet"]'));
  await typeInto("add-card-text", "Fix the flicker on the phone board");
  await phone.eval(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(photo)}), (c) => c.charCodeAt(0)); const input = document.querySelector('[data-testid="add-card-file"]'); const dt = new DataTransfer(); dt.items.add(new File([bytes], "shot.png", { type: "image/png" })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until("the photo uploaded", () => phone.eval(`document.querySelector('[data-testid="add-card-photo"]')?.dataset.state === "ready"`)).catch(async (e) => {
    throw new Error(`${e.message}: ${await phone.eval(`document.querySelector('[data-testid="add-card-sheet"]')?.innerText + ' | ' + document.querySelector('[data-testid="add-card-photo"]')?.dataset.state`)}`);
  });
  await shot("27-add-card");
  await click("add-card-submit");
  const added = await until("the new card on the host", async () => (await A.ok("board.get")).cards.find((c) => c.title.includes("flicker")));
  check(added.column === "todo" && added.notes.includes("Attachments") && added.notes.includes("shot.png"), "Add card sends the description and photo to the host's addCard", added.notes);
  await until("its triage chat", async () => (await card(added.id))?.chats.length > 0, 30_000).catch(() => undefined);
  check((await card(added.id))?.chats.length > 0, "the host starts the new card's triage chat");

  // Card actions: Investigate opens a chat on the card; Chat about it carries the card.
  await until("the cards", async () => (await count("card")) >= 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card-row"]')].find((e) => e.innerText.includes("second")).click()`);
  await until("the card page", () => exists('[data-testid="card-task-investigate"]'));
  await click("card-task-investigate");
  await until("the investigate chat", () => exists('[data-testid="send"]'), 30_000);
  await until("the chat on the card", async () => (await card("bdone2"))?.chats.length > 0, 30_000);
  check(true, "Investigate starts a chat on the host and attaches it to the card");
  await shot("28-investigate-chat");
  await tapBack();
  await until("the board", () => exists('[data-testid="board-screen"]'));
  await until("the cards", async () => (await count("card")) >= 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card-row"]')].find((e) => e.innerText.includes("second")).click()`);
  await until("the card page", () => exists('[data-testid="card-task-discuss"]'));
  await click("card-task-discuss");
  await until("the new chat", () => exists('[data-testid="card-chip"]'));
  check(true, "Chat about it opens a new chat with the card in its composer");
  await phone.eval("document.querySelector('textarea').focus()");
  await phone.send("Input.insertText", { text: "what is this card?" });
  await click("send");
  await until("the second chat on the card", async () => (await card("bdone2"))?.chats.length > 1, 30_000);
  check(true, "sending joins the chat to the card");
  await tapBack();
  await until("the board", () => exists('[data-testid="board-screen"]'));
}

async function tapBackIfPage(phone) {
  await phone.eval(`document.querySelector('[data-testid="card-page"] [aria-label="Back"]').click()`);
  await sleep(300);
  return phone.eval(`!document.querySelector('[data-testid="card-page"]')`);
}

/** The phone's Laments page (T30): tabs, order, expansion with report/fix links, resolve/reopen, delete with confirmation, Fix. */
async function lamentChecks({ phone, A, shot, text, exists, present }) {
  log("mobile laments parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const titles = () => phone.eval(`[...document.querySelectorAll('[data-testid="lament"] [data-testid="lament-row"] span.flex-1')].map((e) => e.innerText)`);
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("the project sheet", () => exists('[data-testid="act-laments"]'));
  await click("act-laments");
  await until("the laments", () => exists('[data-testid="lament"]'));
  await sleep(400);
  const open = await titles();
  check(open.length === 2 && open[0].includes("record a browser tab") && open[1].includes("Slow grep"), "Open lists the worst lament first, then the milder one", open);
  const body = await text();
  check(/Open\s*2/.test(body) && /Resolved\s*1/.test(body) && body.includes("×2"), "the tabs carry counts and the repeat shows ×2");
  await shot("21-laments");
  await click("lament-row");
  await until("the detail", () => exists('[data-testid="lament-detail"]'));
  check((await text()).includes("Hit again; blocking now") && (await phone.eval(`!!document.querySelector('[data-testid="lament-detail"] strong')`)), "expanding shows every report, as Markdown");
  check((await count("report-chat")) === 2, "each report links to the chat that filed it");
  await shot("22-lament-expanded");
  await click("report-chat");
  await until("the filing chat", () => exists('[data-testid="send"]'));
  check(true, "a report's chat link opens that chat");
  await tapBack();
  await until("the laments again", () => exists('[data-testid="lament"]'));

  const lamentState = async (id) => (await A.ok("laments.get")).laments.find((l) => l.id === id);
  await click("lament-actions");
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  const sheet = await text();
  check(["Fix", "Mark resolved", "Delete…"].every((l) => sheet.includes(l)), "the actions sheet offers Fix, Mark resolved and Delete");
  await shot("23-lament-sheet");
  await click("action-resolve");
  await until("resolved on the host", async () => Boolean((await lamentState("aaaaaa"))?.resolvedAt));
  check(true, "Mark resolved is saved on the host");
  await click("tab-resolved");
  await until("two resolved", async () => (await count("lament")) === 2);
  await phone.eval(`document.querySelector('[data-testid="lament-actions"]').click()`);
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  check(!(await exists('[data-testid="action-fix"]')) && (await text()).includes("Reopen"), "a resolved lament offers Reopen and no Fix");
  await click("action-resolve");
  await until("reopened on the host", async () => !(await lamentState("aaaaaa"))?.resolvedAt && !(await lamentState("cccccc") === undefined));
  check(true, "Reopen is saved on the host");
  await click("tab-open");
  await until("two open", async () => (await count("lament")) === 2);

  await phone.eval(`document.querySelectorAll('[data-testid="lament-actions"]')[1].click()`);
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  await click("action-delete");
  await until("the confirmation", () => exists('[data-testid="confirm-delete"]'));
  check(Boolean(await lamentState("bbbbbb")), "before confirming, the lament is still on the host");
  await shot("24-lament-delete");
  await click("confirm-delete");
  await until("deleted on the host", async () => !(await lamentState("bbbbbb")));
  check(true, "Delete asks first, then removes the lament on the host");

  // Fix works in a git worktree: it needs a commit to branch from.
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  await click("lament-actions");
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  await click("action-fix");
  await until("the Fix chat on the host", async () => ((await lamentState("aaaaaa"))?.fixes ?? []).length > 0, 30_000);
  await until("the Fix chat", () => exists('[data-testid="send"]'));
  check(true, "Fix starts a chat on the host and opens it on the phone");
  await shot("25-lament-fix");
}

/** The phone's Settings (T33): sections, host-side effect of each change, the Mac-only things hidden. */
async function settingsChecks({ phone, A, shot, text, exists, present }) {
  log("mobile settings parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const clickText = (testId, label) => phone.eval(`(() => { const e = [...document.querySelectorAll('[data-testid="${testId}"]')].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const toggle = (name) => phone.eval(`document.querySelector('[role="switch"][aria-label="${name}"]').click()`);
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await click("open-settings");
  await until("the sections", () => exists('[data-testid="section-general"]'));
  const list = await text();
  check(["General", "Appearance", "Models", "Agent", "Features", "Computer use", "Remote access", "Updates", "Providers"].every((l) => list.includes(l)) && (await exists('[data-testid="section-providers"]')) && !(await exists('[data-testid="section-shortcuts"]')), "the sections list has everything but Shortcuts (Providers arrived with T34)");
  await shot("17-settings");

  await click("section-appearance");
  await until("appearance", () => exists('[data-testid="settings-appearance"]'));
  await clickText("choice-Mac theme", "Mac theme");
  await until("the theme sheet", () => exists('[data-testid="choice-sheet"]'));
  check(await clickText("choice-option", "dark"), "the phone picks the dark theme");
  await until("the theme on the host", async () => (await A.ok("settings.get")).theme === "dark");
  check(true, "the Mac's theme setting changed from the phone");
  await shot("18-appearance");
  await A.ok("settings.apply", { op: { type: "theme", theme: "system" }, baseRev: (await A.ok("settings.get")).rev });
  await tapBack();

  await until("sections", () => exists('[data-testid="section-agent"]'));
  await click("section-agent");
  await until("agent", () => exists('[data-testid="settings-agent"]'));
  await toggle("Inline visuals");
  await until("visuals on the host", async () => (await A.ok("settings.get")).visuals === true);
  check(true, "Inline visuals (Beta) switched on from the phone");
  await toggle("Retry automatically");
  await until("pi setting on the host", async () => (await A.ok("settings.pi")).values["retry.enabled"] === false);
  check(true, "a pi setting (retry) was written to pi's settings.json");
  await shot("19-agent");
  await toggle("Retry automatically");
  await toggle("Inline visuals");
  await tapBack();

  await click("section-features");
  await until("features", () => exists('[data-testid="settings-features"]'));
  await toggle("Laments");
  await until("laments off on the host", async () => (await A.ok("settings.get")).features.laments === false);
  check(true, "a feature switch changed on the host");
  await toggle("Laments");
  await until("laments on", async () => (await A.ok("settings.get")).features.laments === true);
  await tapBack();

  await click("section-computer");
  await until("computer", () => exists('[data-testid="settings-computer"]'));
  await until("permission status", async () => /Granted|Not granted|Unknown/.test(await text()));
  check(!(await text()).includes("Open System Settings"), "computer use shows no System Settings button");
  await shot("20-computer");
  await tapBack();

  await click("section-remote");
  await until("remote", () => exists('[data-testid="settings-remote"]'));
  await until("devices", () => exists('[data-testid="device-row"]'));
  const rows = await phone.eval(`document.querySelectorAll('[data-testid="device-row"]').length`);
  const revokes = await phone.eval(`document.querySelectorAll('[data-testid="revoke-device"]').length`);
  check((await text()).includes("(this device)") && revokes === rows - 1, "the device list marks this device and offers Revoke only for the others", { rows, revokes });
  await click("revoke-device");
  await click("revoke-device");
  await until("the other device revoked on the host", async () => (await A.ok("devices.list")).length === rows - 1);
  check(true, "Revoke on the phone removes the other device on the host");
  check(await exists('[data-testid="sign-out"]'), "Sign out is in Remote access");
  await shot("21-remote");
  await tapBack();

  await click("section-updates");
  await until("updates", () => exists('[data-testid="settings-updates"]'));
  check((await text()).includes("up to date") || (await text()).includes("available"), "Updates shows the status");
  await tapBack();
}

/** The phone's composer chrome (T26): model and thinking sheets, commands, mentions, context meter, queue, extension UI. */
/** The phone's transcript extras (T28): tool sheets, expand all, images and the lightbox, the turn list and bookmarks, visuals, copy, links, times. */
async function transcriptChecks({ phone, A, shot, text, tap, exists, present }) {
  log("mobile transcript extras");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (selector) => phone.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const clickText = (selector, label) => phone.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const scale = () => phone.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.querySelector('[data-testid="lightbox"] img')?.style.transform ?? ""); return m ? Number(m[1]) : 0; })()`);
  const touch = (type, points) => phone.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

  // Open the tools session: back out to Projects, then the project's list.
  for (let i = 0; i < 6 && !(await exists('[data-testid="open-settings"]')); i++) {
    await phone.eval(`document.querySelector('[aria-label="Back"]')?.click()`);
    await sleep(500);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await sleep(500);
  await tap("project");
  await until("the chats list", present("Tools demo"));
  check(await tap("Tools demo"), "the phone opens the tools session");
  await until("the tools transcript", present("Second answer."));
  await sleep(800);
  await shot("22-tools-chat");

  // Large images come by URL, not inside the JSON, and only to a paired device.
  const photo = await until("the user's photo to load", () =>
    phone.eval(`(() => { const img = [...document.images].find((i) => i.getAttribute("src")?.startsWith("/api/image/")); return img && img.complete && img.naturalWidth === 200 ? img.getAttribute("src") : ""; })()`),
  );
  check(true, "the transcript shows the large photo from /api/image/<id>");
  const fetched = await request(A.port, { path: photo, headers: A.headers() });
  check(fetched.status === 200 && fetched.headers["content-type"] === "image/png" && /immutable/.test(fetched.headers["cache-control"] ?? ""), "the image URL serves the PNG, cacheable", fetched.headers);
  const stranger = await request(A.port, { path: photo, headers: { ...A.headers(), cookie: "" } });
  check(stranger.status === 401 || stranger.status === 403, "an unpaired browser cannot load it", stranger.status);

  // Tool detail sheets.
  check(await clickText("button", "Worked"), "the first turn's work accordion opens");
  await until("the tool rows", present("ls --color"));
  check(!(await exists('[data-testid="tool-sheet"]')), "a tool's details start closed");
  check(await clickText("button", "ls --color"), "tapping a bash call opens its sheet");
  await until("the bash sheet", () => exists('[data-testid="tool-sheet"]'));
  const sheet = () => phone.eval(`document.querySelector('[data-testid="tool-sheet"]')?.innerText ?? ''`);
  check((await sheet()).includes("red-file") && !(await sheet()).includes("[31m"), "bash output shows without raw ANSI codes", await sheet());
  check((await sheet()).includes("Copy output"), "the sheet offers copying the output");
  await shot("23-bash-sheet");
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);
  check(await clickText("button", "src/a.ts"), "tapping an edit opens its sheet");
  await until("the edit sheet", () => exists('[data-testid="tool-sheet"]'));
  check(
    await phone.eval(`[...document.querySelectorAll('[data-testid="tool-sheet"] .overflow-auto')].some((e) => e.scrollWidth > e.clientWidth + 20)`),
    "the diff scrolls sideways instead of wrapping its long line",
  );
  await shot("24-edit-sheet");
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);
  check(await clickText("button", "frobnicate"), "a generic tool opens its sheet");
  await until("the generic sheet", () => exists('[data-testid="tool-sheet"]'));
  check((await sheet()).includes('"level": 3') && (await sheet()).includes("frobbed"), "the generic sheet shows the JSON arguments and the result", await sheet());
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);

  // Expand all.
  const rowsClosed = await count('[data-testid="tool-sheet"]');
  check(rowsClosed === 0, "no sheet is left open");
  check(!(await text()).includes("const veryLongLine"), "steps are collapsed before Expand all");
  check(await click("expand-all"), "the header's Expand all is tapped");
  await until("the steps open inline", present("const veryLongLine"));
  await click("expand-all");
  await until("the steps close again", async () => !(await text()).includes("const veryLongLine"));

  // Images and the lightbox.
  check((await count("img")) >= 2, "the transcript shows the message's image and the tool's image");
  check(await phone.eval(`(() => { const i = document.querySelector('button img'); i.closest('button').click(); return true; })()`), "an image is tapped");
  await until("the lightbox", () => exists('[data-testid="lightbox"]'));
  check((await scale()) === 1, "the lightbox opens at fit size");
  const [cx, cy] = [196, 426];
  await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
  await touch("touchMove", [[cx - 90, cy], [cx + 90, cy]]);
  await touch("touchEnd", []);
  await sleep(300);
  const zoomed = await scale();
  check(zoomed > 1.5, "a two-finger spread zooms the image", zoomed);
  await shot("25-lightbox-zoom");
  check(await phone.eval(`document.querySelector('[data-testid="lightbox"] img').tagName === "IMG" && !document.querySelector('[data-testid="lightbox"] img').closest("a,button")`), "the image is a plain <img>, so iOS offers Save and Copy on a long press");
  check(await phone.eval(`(() => { document.querySelector('[aria-label="Close image"]').click(); return true; })()`), "the lightbox's close button is tapped");
  await until("the lightbox to close", async () => !(await exists('[data-testid="lightbox"]')));

  // Times on tap, copy, links.
  check(!(await exists('[data-testid="user-stamp"]')), "no time is shown on a message until it is tapped");
  check(await phone.eval(`(() => { document.querySelector('[data-user-bubble]').click(); return true; })()`), "a message is tapped");
  await until("the message time", () => exists('[data-testid="user-stamp"]'));
  check(await phone.eval(`!!document.querySelector('[title="Copy answer"]')`), "a finished answer has a copy button");
  await phone.eval(`window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null; }; true`);
  check(await phone.eval(`(() => { const a = [...document.querySelectorAll("a")].find((x) => x.href.startsWith("https://example.com/docs")); if (!a) return false; a.click(); return true; })()`), "a link in an answer is tapped");
  check((await phone.eval("window.__opened")).includes("https://example.com/docs"), "links open in the phone's browser", await phone.eval("window.__opened"));

  // Visuals: tap to render, sandboxed frame from the host, watchdog.
  // The settings checks left Inline visuals however they found it: switch it on from the host; the phone follows live.
  const current = await A.ok("settings.get");
  if (!current.visuals) await A.ok("settings.apply", { op: { type: "visuals", on: true }, baseRev: current.rev });
  await until("the visual placeholders", () => exists('[data-testid="visual-tap"]'));
  check((await count("iframe")) === 0, "no visual runs before it is tapped");
  check(await click("visual-tap"), "the first visual is tapped");
  await until("the visual frame", () => exists("iframe.visual-frame"));
  const frame = await phone.eval(`(() => { const f = document.querySelector("iframe.visual-frame"); return { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src") }; })()`);
  check(frame.sandbox === "allow-scripts", "the frame is sandboxed with scripts only (opaque origin)", frame.sandbox);
  check(/^\/visual\/[0-9a-f]{16}\/doc$/.test(frame.src), "the frame loads from the host's /visual path", frame.src);
  await until("the frame to size itself", () => phone.eval(`document.querySelector("iframe.visual-frame").offsetHeight > 41`), 15_000, 200).catch(async (error) => {
    log(`  frame: ${await phone.eval(`(() => { const f = document.querySelector("iframe.visual-frame"); return JSON.stringify({ h: f?.offsetHeight, err: document.querySelector(".visual-error")?.innerText }); })()`)}`);
    throw error;
  });
  await shot("26-visual");
  const headers = await phone.eval(`fetch(${JSON.stringify(frame.src)}).then((r) => ({ status: r.status, csp: r.headers.get("content-security-policy") }))`);
  check(headers.status === 200 && /default-src 'none'/.test(headers.csp) && /connect-src 'none'/.test(headers.csp), "the frame document carries the visual CSP", headers);
  // The second visual stops its heartbeat: the watchdog removes the frame and shows the source.
  check(await phone.eval(`(() => { const t = [...document.querySelectorAll('[data-testid="visual-tap"]')]; if (!t[0]) return false; t[0].click(); return true; })()`), "the second visual is tapped");
  await until("the watchdog to fire", present("Visual stopped responding"), 20_000, 500);
  check((await count("iframe.visual-frame")) === 1, "the stuck frame is removed (the healthy one stays)");
  check((await text()).includes("clearInterval"), "its source is shown instead");
  await shot("27-visual-stuck");

  // Turn list and bookmarks (the host keeps them).
  check(await click("turn-list-button"), "the turn list button is tapped");
  await until("the turn list", () => exists('[data-testid="turn-list"]'));
  check((await count('[data-testid="turn-row"]')) === 2, "the list has one row per message sent", await count('[data-testid="turn-row"]'));
  await shot("28-turn-list");
  check(await phone.eval(`(() => { document.querySelector('[data-testid="turn-list"] [aria-label="Bookmark"]').click(); return true; })()`), "the first turn's star is tapped");
  await until("the host to hold the bookmark", async () => Object.values((await A.ok("ui.get")).bookmarks ?? {}).some((marks) => marks.length === 1));
  check(true, "the bookmark is in the host's ui state");
  await phone.eval(`window.__flashes = 0; const animate = Element.prototype.animate; Element.prototype.animate = function (...args) { window.__flashes++; return animate.apply(this, args); }; true`);
  check(await clickText('[data-testid="turn-row"]', "Second turn"), "the second turn's row is tapped");
  await until("the list to close", async () => !(await exists('[data-testid="turn-list"]')));
  await until("the view to scroll to the second turn", () => phone.eval(`(() => { const s = document.querySelector('[data-run]:last-of-type'); const sc = s?.closest(".overflow-y-auto"); return !!sc && sc.scrollTop > 0; })()`), 8_000, 100);
  check((await phone.eval("window.__flashes")) >= 1, "the jump flashes the message");
  await shot("29-after-jump");
}

async function composerChecks({ phone, A, handle, shot, text, tap, exists, present }) {
  log("mobile composer parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const clickText = (testId, label) => phone.eval(`(() => { const e = [...document.querySelectorAll('[data-testid="${testId}"]')].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const value = () => phone.eval("document.querySelector('textarea').value");
  const type = async (t) => {
    await phone.eval("document.querySelector('textarea').focus()");
    await phone.send("Input.insertText", { text: t });
  };
  const clear = async () => {
    await phone.eval("(() => { const t = document.querySelector('textarea'); t.focus(); t.select(); })()");
    await phone.send("Input.insertText", { text: "" });
    await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await phone.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  };
  const state = async () => (await A.ok("chat.command", { handle, command: { type: "get_state" } })).data;
  const label = (testId) => phone.eval(`document.querySelector('[data-testid="${testId}"]')?.innerText ?? ''`);
  const idle = () => until("the run to end", async () => !(await exists('[data-testid="stop"]')), 30_000, 100);

  // Model and thinking sheets, calling chat.command on the host.
  await until("the model chip", () => exists('[data-testid="model-chip"]'));
  check((await label("model-chip")).trim().startsWith("Fake"), "the model chip names the model", await label("model-chip"));
  check(!(await exists('[data-testid="thinking-chip"]')), "no thinking chip for a model without reasoning");
  await click("model-chip");
  await until("the model sheet", () => exists('[data-testid="model-option"]'));
  await shot("8-model-sheet");
  check(await clickText("model-option", "Fake Large"), "the sheet lists Fake Large and the phone taps it");
  await until("the new model", async () => (await label("model-chip")).includes("Fake Large"));
  check((await state()).model.id === "fake-large", "the host runs the chosen model");
  await until("the thinking chip", () => exists('[data-testid="thinking-chip"]'));
  await click("thinking-chip");
  await until("the thinking sheet", () => exists('[data-testid="thinking-option"]'));
  await shot("9-thinking-sheet");
  check(await clickText("thinking-option", "high"), "the phone picks the thinking level high");
  await until("the level on the chip", async () => (await label("thinking-chip")).includes("high"));
  check((await state()).thinkingLevel === "high", "the host runs the chosen thinking level");

  // Slash commands and @ mentions as touch lists.
  await type("/");
  await until("the command list", () => exists('[data-testid="menu-item"]'));
  await shot("10-commands");
  check((await text()).includes("/compact"), "typing / lists pi's commands");
  check(await clickText("menu-item", "/review"), "the phone taps a command");
  check((await value()) === "/review ", "the command lands in the composer", await value());
  await clear();
  await type("look at @notes-al");
  await until("the file list", () => exists('[data-testid="menu-item"]'));
  await shot("11-mentions");
  check(await clickText("menu-item", "notes-alpha.md"), "typing @ lists project files and the phone taps one");
  check((await value()) === "look at @notes-alpha.md ", "the mention lands in the composer", await value());
  await clear();

  // Context meter sheet and Compact now.
  await until("the context meter", () => phone.eval(`!!document.querySelector('button[aria-label^="Context usage"]')`));
  check((await phone.eval(`document.querySelector('button[aria-label^="Context usage"]').innerText`)).includes("25%"), "the meter shows the context share");
  await phone.eval(`document.querySelector('button[aria-label^="Context usage"]').click()`);
  await until("the context sheet", () => exists('[data-testid="context-sheet"]'));
  await shot("12-context");
  const sheetText = await phone.eval(`document.querySelector('[data-testid="context-sheet"]').innerText`);
  check(/Auto-compacts at/.test(sheetText) && /Cache hit/.test(sheetText) && /Compact now/.test(sheetText), "the sheet shows tokens, the auto-compaction point, cache hits and Compact now", sheetText.slice(0, 200));
  check(await tap("Compact now"), "the phone taps Compact now");
  await until("the meter after compaction", async () => (await phone.eval(`document.querySelector('button[aria-label^="Context usage"]')?.innerText ?? ''`)).includes("10%"), 20_000, 200);
  check(true, "the context meter follows the compaction");

  // The queue card: a run with two follow-ups.
  await type("queue run [lines=300][delay=100]");
  await click("send");
  await until("the run", () => exists('[data-testid="stop"]'));
  for (const t of ["follow one", "follow two"]) {
    await type(t);
    await until("Queue to enable", () => phone.eval(`document.querySelector('[data-testid="queue"]')?.disabled === false`));
    await click("queue");
    await until("the draft to clear", async () => (await value()) === "");
  }
  await until("two queue rows", async () => (await phone.eval(`document.querySelectorAll('[data-testid="queue-row"]').length`)) === 2);
  await shot("13-queue");
  check(await phone.eval(`!!document.querySelector('[data-testid="queue-steer"]') && !!document.querySelector('[data-testid="queue-edit"]') && !!document.querySelector('[data-testid="queue-delete"]')`), "queue rows offer Steer now, Edit and Remove");
  await phone.eval(`document.querySelector('[data-testid="queue-steer"]').click()`);
  await until("a steering row", () => phone.eval(`!!document.querySelector('[data-testid="queue-row"][data-kind="steering"]')`));
  check(true, "Steer now moves a follow-up to steering");
  await phone.eval(`[...document.querySelectorAll('[data-testid="queue-row"]')].at(-1).querySelector('[data-testid="queue-edit"]').click()`);
  await until("the edit to reach the composer", async () => (await value()).includes("follow"));
  check(true, "Edit takes the message back into the composer");
  await clear();
  await until("one row left", async () => (await phone.eval(`document.querySelectorAll('[data-testid="queue-row"]').length`)) === 1);
  await phone.eval(`document.querySelector('[data-testid="queue-delete"], [data-testid="queue-defer"]') && document.querySelector('[data-testid="queue-delete"]').click()`);
  await until("the queue to empty", () => phone.eval(`!document.querySelector('[data-testid="queue-card"]')`));
  check(true, "Remove deletes a queued message");
  await click("stop");
  await click("confirm-stop");
  await idle();

  // Extension UI and retry callouts.
  await type("ext-ui retry-demo [lines=40][delay=100]");
  await click("send");
  await until("the extension widget", () => exists('[data-testid="widget"]'));
  await shot("14-extension-ui");
  check((await text()).includes("fake widget line"), "an extension widget shows above the composer");
  check((await text()).includes("fake-ext: heads up"), "an extension notify becomes a toast");
  await until("the editor text", async () => (await value()) === "prefilled by fake-ext");
  check(true, "set_editor_text fills the composer");
  await until("the retry callout", () => exists('[data-testid="retry-callout"]'));
  check((await text()).includes("Retrying (1/3)"), "an auto-retry shows a callout");
  await click("stop");
  await click("confirm-stop");
  await idle();
  await clear();
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
