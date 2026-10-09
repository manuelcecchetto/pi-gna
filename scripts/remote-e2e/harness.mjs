// Shared harness of the remote end-to-end scenarios (docs/REMOTE.md, "Automated end-to-end tests"). Each scenario file in this
// folder is its own small test: `scenario()` builds the app (or reuses SLICE_E2E_APP), starts a fresh test instance (own
// PIGNA_USER_DATA, own free ports, PIGNA_BACKGROUND=1, scripts/fake-pi.mjs as pi), pairs two phones, runs the body, and stops
// the instance by PID. Nothing touches a running pi-gna. Uses Node's built-in fetch/WebSocket/http; no dependencies.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const flags = process.argv.slice(2);
export const flag = (name) => flags.includes(name);
const shotsDir = flags.includes("--shots") ? flags[flags.indexOf("--shots") + 1] : undefined;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (line) => console.log(line);
const failures = [];
/** One assertion: printed as it happens, collected, and decides the exit code. */
export function check(ok, label, detail) {
  log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}
export async function until(what, probe, timeoutMs = 20_000, everyMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

// ── The test instance ────────────────────────────────────────────────────────

const base = realpathSync(tmpdir());
const work = join(base, `pigna-remote-e2e-${basename(process.argv[1] ?? "x", ".e2e.mjs")}-${randomUUID().slice(0, 8)}`);
// SLICE_E2E_APP=<folder> reuses an earlier build (a folder buildApp made; scripts/remote-e2e/run.mjs builds one for all scenarios).
const appDir = process.env.SLICE_E2E_APP ?? join(work, "app");
const userData = join(work, "ud");
export const project = join(work, "project");
const agentDir = join(work, "agent");
const sessionsDir = join(agentDir, "sessions");
export const responses = join(work, "fake-pi-responses.log");
let instance;
let proxy;

/** Builds the app into `dir`: both bundles, package.json, and links to node_modules, resources and src. */
export function buildApp(dir) {
  mkdirSync(dir, { recursive: true });
  // One build id for both bundles, as scripts/build.mjs does: the phone reloads itself when /api/hello disagrees with it.
  const env = { PIGNA_BUILD: "slice-e2e" };
  const run = (args) => {
    const result = spawnSync("pnpm", ["exec", ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  };
  run(["electron-vite", "build", "--outDir", join(dir, "out")]);
  run(["vite", "build", "-c", "vite.mobile.config.ts", "--outDir", join(dir, "out", "mobile"), "--emptyOutDir"]);
  copyFileSync(join(root, "package.json"), join(dir, "package.json"));
  // The extensions import ../src/shared, and the app reads resources next to itself.
  for (const name of ["node_modules", "resources", "src"]) symlinkSync(join(root, name), join(dir, name));
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
  // Project-owned theme images exercise the same confined-file path as real projects.
  mkdirSync(join(project, "assets"), { recursive: true });
  writeFileSync(join(project, "assets", "theme-wallpaper.png"), Buffer.from(png(32, 24, [24, 90, 170]), "base64"));
  writeFileSync(join(project, "assets", "theme-logo.png"), Buffer.from(png(20, 20, [220, 80, 40]), "base64"));
  // Remote access on through the profile's settings; the server follows them at launch. The chats pi-gna starts itself (card
  // triage, ATP orchestrator and workers) run on fake-pi's model: the defaults name models fake-pi does not have.
  const fake = { provider: "fake", id: "fake", thinking: "off" };
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ version: 1, visuals: true, models: { triage: fake, orchestrator: fake, worker: fake }, remote: { enabled: true, port: ports.remote, keepAwake: "off" } }));
  return file;
}

/** A solid-color PNG (zlib from node), for image blocks; `noise` makes it incompressible (a photo-sized block). */
export function png(width, height, [r, g, b], noise = false) {
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

const VISUAL_OK = '<div class="stack"><div class="stat"><span class="stat-value" id="v">42</span><span class="stat-label">answers</span></div></div><script>const themeFixtureSentinel=1;window.__themeFixtureRuns=(window.__themeFixtureRuns||0)+1;window.addEventListener("message",e=>{if(e.source===parent&&(e.data?.type==="tokens"||e.data?.type==="render")){setTimeout(()=>parent.postMessage({type:"theme-proof",mode:document.documentElement.dataset.themeMode,accent:getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),size:getComputedStyle(document.documentElement).getPropertyValue("--app-font-size").trim(),runs:window.__themeFixtureRuns},"*"),0)}})</script>';
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
  const electron = spawnSync("node", ["-e", 'console.log(require("electron"))'], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n").at(-1); // the last line: a first run prints "Downloading Electron binary..." before it
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

export class Cdp {
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
export function request(port, { method = "GET", path, headers = {}, body }) {
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
export class Sse {
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

export class Phone {
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

export const records = (events, topic) => events.filter((e) => e.topic === topic && e.event.kind === "rpc").map((e) => e.event.record);
/** The assistant text deltas of a stream, in order. */
/** The streamed text pieces; the host merges the deltas of a frame (src/main/coalesce.ts), so each is split back into fake-pi's paragraphs. */
export const deltas = (events, topic) => records(events, topic).filter((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta").flatMap((r) => r.assistantMessageEvent.delta.split(/(?<=\n\n)/));
export const messageEnds = (events, topic, role) => records(events, topic).filter((r) => r.type === "message_end" && r.message.role === role);
export const userTexts = (events, topic) => messageEnds(events, topic, "user").map((r) => (typeof r.message.content === "string" ? r.message.content : r.message.content.map((c) => c.text).join("")));
export const lineNumbers = (events, topic) => deltas(events, topic).map((d) => Number(/^Line (\d+) /.exec(d)?.[1]));
export const contiguous = (numbers) => numbers.length > 0 && numbers.every((n, i) => n === numbers[0] + i);
export const agentEnds = (events, topic) => records(events, topic).filter((r) => r.type === "agent_end").length;
export const finalText = (events, topic) => messageEnds(events, topic, "assistant").at(-1)?.message.content.map((c) => c.text).join("") ?? "";
export const lastLine = (text) => Number([...text.matchAll(/^Line (\d+) /gm)].at(-1)?.[1] ?? 0);

export async function pairPhone(phone, desktop) {
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

// ── Desktop helpers ──────────────────────────────────────────────────────────

/** Opens a session from the sidebar, as a click would. */
export async function showSession(desktop, title) {
  // A pairing request opens Settings on the Mac; go back to the chat page first.
  await desktop.eval(`[...document.querySelectorAll("button")].find((x) => x.innerText.startsWith("Back to app"))?.click()`);
  await until("the sidebar row", () => desktop.eval(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.startsWith(${JSON.stringify(title)})); if (!b) return false; b.click(); return true; })()`), 20_000, 250);
}
/** The desktop's rendered transcript (or, with `all`, the whole page, which includes approval cards). */
export const desktopText = (desktop, all = false) =>
  desktop.eval(all ? "document.body.innerText" : `document.querySelector('div[class*="max-w-[800px]"][class*="gap-10"]')?.innerText ?? ""`);
/** The desktop's last answer (the lines since the last "Line 1") is 1..`last`, each once. */
export async function desktopHasLines(desktop, last) {
  const text = await desktopText(desktop);
  const lines = [...text.matchAll(/^Line (\d+) of the streamed/gm)].map((m) => Number(m[1]));
  const answer = lines.slice(lines.lastIndexOf(1));
  return answer.length === last && contiguous(answer) && answer.at(-1) === last;
}
/** The host says the chat is idle and the desktop's store caught up. */
export async function settled(desktop, handle) {
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

/**
 * The mobile app in an offscreen window of the instance itself (iPhone 15 preset), paired as phone `A` through a proxy that adds
 * what Tailscale serve adds. The instance runs in the background (PIGNA_BACKGROUND=1), where windows and browser tabs draw no
 * frames and cannot be captured (docs/DESIGN.md "Verifying the UI"); offscreen rendering paints regardless, and the iPhone
 * emulation goes through the same debugger protocol as the browser's. Resolves once the Projects screen shows.
 * A finger dragged to scroll must be held still before `touchEnd`: lifting a moving one starts a fling, and a fling in an
 * offscreen window crashes Electron 44's main process (EXC_BAD_ACCESS in CrBrowserMain), in about half the mobile-chat runs
 * once the app's animations moved to the compositor (P16). The app has no offscreen windows; only this phone does.
 */
export async function openPhone({ ports, A }) {
  log("mobile app (iPhone 15 preset in the instance's own offscreen window)");
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
  const present = (needle) => async () => (await text()).includes(needle);
  const exists = (selector) => phone.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
  await until("the projects screen", present("project"), 30_000, 250);
  if (flag("--debug")) log(`  page ${await phone.eval("location.href")}: ${(await text()).slice(0, 300)}`);
  const close = async () => {
    await mainEval(`${view}.debugger.detach(), globalThis.__sliceWin.destroy(), true`);
    inspector.close();
  };
  return { phone, shot, text, tap, exists, present, close };
}

/** On the phone: Projects, the project's chats, then the chat whose title starts with `title`. */
export async function openChatOnPhone({ phone, tap, exists, present }, title = "Earlier question 1") {
  await until("the project row", () => tap("project"), 20_000, 250);
  await until("the chats screen", present(title));
  await tap(title);
  await until("the chat", () => exists('[data-testid="send"]'));
}

/**
 * Runs one scenario against a fresh instance and exits with 0 only when every check passed. `body` gets
 * `{ A, B, desktop, ports, project, sessionFile, instance, openChat, restart }`; with `pair: false` the phones are left unpaired.
 * Flags: --keep (keep the work folder), --shots <dir>, --hold (stay up at the end for manual poking), --debug.
 */
export async function scenario(title, body, { pair = true } = {}) {
  let exitCode = 1;
  let ctx;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stopInstance().finally(() => process.exit(130)));
  try {
    log(`── ${title}`);
    mkdirSync(work, { recursive: true });
    log(`work folder ${work}`);
    if (!process.env.SLICE_E2E_APP) {
      log("building the app into its own folder ...");
      buildApp(appDir);
    } else if (!existsSync(join(appDir, "out"))) throw new Error(`SLICE_E2E_APP=${appDir} holds no build`);
    const ports = { debug: await freePort(), inspect: await freePort(), remote: await freePort() };
    const sessionFile = seed(ports);
    instance = launch(ports);
    log(`instance pid ${instance.pid}, debug ${ports.debug}, inspect ${ports.inspect}, remote ${ports.remote}`);
    const A = new Phone(ports.remote, "A", "alice@example.com");
    const B = new Phone(ports.remote, "B", "alice@example.com");
    ctx = {
      A,
      B,
      ports,
      project,
      sessionFile,
      desktop: await connectDesktop(ports),
      get instance() {
        return instance;
      },
      /** A opens the seeded session (the desktop shows it too) and gets its handle. */
      async openChat() {
        const { handle } = await A.ok("chat.open", { request: { cwd: project, sessionPath: sessionFile } });
        await showSession(ctx.desktop, "Earlier question 1");
        await until("the desktop to show the session", async () => (await desktopText(ctx.desktop)).includes("Earlier answer 3."));
        return handle;
      },
      /** Stops the instance and starts it again on the same profile and ports; the desktop reconnects. */
      async restart() {
        ctx.desktop.close();
        await stopInstance();
        instance = launch(ports);
        ctx.desktop = await connectDesktop(ports);
      },
    };
    if (pair) {
      await pairPhone(A, ctx.desktop);
      await pairPhone(B, ctx.desktop);
    }
    await body(ctx);
    if (flag("--hold")) {
      log(`holding; debug port ${ports.debug}; Ctrl-C to stop`);
      await new Promise(() => undefined);
    }
    exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message ?? error));
  } finally {
    ctx?.desktop.close();
    proxy?.close();
    await stopInstance();
    if (!flag("--keep") && failures.length === 0) rmSync(work, { recursive: true, force: true });
    else log(`kept ${work} (app.log inside)`);
  }
  log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}` : "\nall checks passed");
  process.exit(exitCode);
}

/** Waits for the instance's window, its first render and the remote server, and returns the window over CDP. */
async function connectDesktop(ports) {
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
  return desktop;
}
