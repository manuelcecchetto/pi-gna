#!/usr/bin/env node
// Dev tool (Windows: process CPU and memory come from Win32_Process): measure pi-gna's startup, opening long chats,
// streaming and idle cost on this machine, end to end, in a throwaway profile with fake pi. Never touches the pi-gna
// you work in or your real sessions (it reads copies). `pnpm build` first. Before/after a change:
//   node scripts/measure-perf.mjs --synthetic 2000 --runs 3 [--throttle 4] [--out perf.json]
//   node scripts/measure-perf.mjs --sessions ~/.pi/agent/sessions [--open 4] [--runs 5] [--profile dir]
// --sessions: a folder of pi session files to copy in (default: none, so only startup, streaming and idle run).
// --open N: open the N largest copied chats one after another (each timed from the palette's Enter to a settled DOM).
// --profile dir: also save renderer and main CPU profiles (.cpuprofile, open in Chrome DevTools > Performance) and a
// 5 s rendering trace from the middle of each stream (printed by event kind). Function names need an unminified
// renderer (`minify: false` in electron.vite.config.ts, for the run only).
// --app path: a packaged pi-gna.exe instead of this checkout's build (run `pnpm build` first for the checkout).
// --synthetic N: also a generated N-turn chat, opened, paged in fully, then streamed into. --many N: N more short chats.
// --throttle N: slow the renderer's CPU N times (a slower laptop). --inject file.js: run it in the window first.
// The window is a PIGNA_BACKGROUND=1 test window (no focus, click-through). Every instance is stopped by its own PID.
// Timings swing with machine load: compare runs taken back to back (before/after a change), not across days.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1];
};
const root = fileURLToPath(new URL("../", import.meta.url));
const sessionsFrom = flag("sessions");
const openCount = Number(flag("open", 4));
const runs = Number(flag("runs", 5));
const outFile = flag("out");
const profileDir = flag("profile");
const appExe = flag("app");
const synthetic = Number(flag("synthetic", 0));
const many = Number(flag("many", 0));
const throttle = Number(flag("throttle", 1));
const electron = appExe ? resolve(appExe) : createRequire(import.meta.url)("electron");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
};
const round = (value) => Math.round(value * 10) / 10;

const work = mkdtempSync(join(tmpdir(), "pigna-perf-"));
const profile = join(work, "profile");
const agent = join(work, "agent");
const project = join(work, "project");
for (const dir of [profile, join(agent, "sessions"), project]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, "README.md"), "# perf project\n");
let copied = [];
if (sessionsFrom) {
  cpSync(resolve(sessionsFrom.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? "~")), join(agent, "sessions"), { recursive: true });
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : []));
  copied = walk(join(agent, "sessions")).map((path) => ({ path, bytes: statSync(path).size })).sort((a, b) => b.bytes - a.bytes);
}

/** A pi session file (v3) of `turns` agent turns: a prompt, a bash call and its output, then a Markdown answer with code. */
function writeSession(cwd, turns, name, stamp) {
  const dir = join(agent, "sessions", `--${cwd.replace(/[\\/:]/g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const uuid = `01a1${stamp.toString(16).padStart(4, "0")}-0000-7000-8000-${String(turns).padStart(12, "0")}`;
  const start = Date.parse("2026-09-01T10:00:00Z") + stamp * 3_600_000;
  let parent = null;
  let n = 0;
  const lines = [JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: new Date(start).toISOString(), cwd })];
  const push = (entry) => {
    const id = (++n).toString(16).padStart(8, "0");
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(start + n * 1000).toISOString(), ...entry }));
    parent = id;
  };
  const usage = { input: 10, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 210, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, stopReason) => ({ message: { role: "assistant", content, api: "fake", provider: "fake", model: "fake", usage, stopReason, timestamp: start + n * 1000 } });
  lines.push(JSON.stringify({ type: "session_info", id: "name0000", parentId: null, timestamp: new Date(start).toISOString(), name }));
  parent = "name0000";
  for (let i = 0; i < turns; i++) {
    push({ message: { role: "user", content: [{ type: "text", text: `Turn ${i}: please check \`src/module${i % 40}.ts\` and fix the failing test.` }], timestamp: start + n * 1000 } });
    const call = `call${i}`;
    push(assistant([{ type: "thinking", thinking: `Looking at module ${i % 40} first.` }, { type: "toolCall", id: call, name: "bash", arguments: { command: `rg -n "fn${i}" src && pnpm test module${i % 40}` } }], "toolUse"));
    push({ message: { role: "toolResult", toolCallId: call, toolName: "bash", content: [{ type: "text", text: Array.from({ length: 30 }, (_, j) => `src/module${i % 40}.ts:${j + 1}: const fn${i}_${j} = () => compute(${j});`).join("\n") }], isError: false, timestamp: start + n * 1000 } });
    push(assistant([{ type: "text", text: `Fixed **turn ${i}**: the test expected \`${i}\`.\n\n- updated the guard\n- kept the API\n\n\`\`\`ts\nexport function fn${i}(value: number): number {\n  if (value < 0) return 0;\n  return value * ${i};\n}\n\`\`\`\n\nAll tests pass.` }], "stop"));
  }
  const path = join(dir, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${uuid}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}
if (synthetic) {
  // Its own project: a launch project with history changes what the first chat does with a prompt.
  const longProject = join(work, "long project");
  mkdirSync(longProject, { recursive: true });
  const path = writeSession(longProject, synthetic, `Synthetic long chat (${synthetic} turns)`, 1);
  copied.push({ path, bytes: statSync(path).size, synthetic: true });
}
// Many short chats across many projects: the session index and sidebar at a heavy user's scale.
for (let i = 0; i < many; i++) {
  const cwd = join(work, "projects", `p${i % 40}`);
  mkdirSync(cwd, { recursive: true });
  writeSession(cwd, 3 + (i % 5), `Chat ${i} about module ${i % 40}`, 100 + i);
}

// A long Markdown answer with code, lists and tables, streamed by fake pi (FAKE_TEXT_FILE).
const langs = ["ts", "python", "bash", "json", "rust"];
const answer = Array.from({ length: 60 }, (_, i) => [
  `## Section ${i + 1}: the **${["parser", "renderer", "index", "bridge"][i % 4]}**`,
  `Paragraph ${i} explains \`function${i}()\` and links [the docs](https://example.com/${i}). `.repeat(4),
  `- item one of ${i}\n- item two with \`code\`\n  - nested *emphasis*\n- item three`,
  "```" + langs[i % langs.length] + "\n" + Array.from({ length: 14 }, (_, j) => `const value${j} = compute(${i}, ${j}); // line ${j} of block ${i}`).join("\n") + "\n```",
  i % 3 ? "" : `| key | value | note |\n|---|---|---|\n${Array.from({ length: 6 }, (_, j) => `| k${j} | ${i * j} | row ${j} |`).join("\n")}`,
].join("\n\n")).join("\n\n");
const answerFile = join(work, "answer.md");
writeFileSync(answerFile, answer);
// An npm-style shim (`node "%~dp0\\entry"`), the form pi-gna resolves to node + script without cmd.exe.
const pi = join(work, "pi.cmd");
// It answers `--version` and sits in a folder named like pi's package, so Setup finds a working pi and stays closed
// (its animations would otherwise be the idle cost measured).
writeFileSync(join(work, "pi-entry.mjs"), `if (process.argv.includes("--version")) console.log("0.0.0-fake");\nelse await import(${JSON.stringify(pathToFileURL(join(root, "scripts", "fake-pi.mjs")).href)});\n`);
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", private: true }));
writeFileSync(pi, '@echo off\r\nnode "%~dp0\\pi-entry.mjs" %*\r\n');

/** Every process under `pid` with CPU seconds and working set, from Windows' process table. */
function processTree(pid) {
  const rows = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,CommandLine | ConvertTo-Json -Compress"],
  { encoding: "utf8", maxBuffer: 64 << 20 }));
  const tree = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) if (tree.has(row.ParentProcessId) && !tree.has(row.ProcessId)) { tree.add(row.ProcessId); grew = true; }
  }
  return rows.filter((row) => tree.has(row.ProcessId)).map((row) => {
    const command = row.CommandLine ?? "";
    const kind = /fake-pi|pi-entry|pi\.cmd|cmd\.exe/.test(command) ? "pi" : command.match(/--type=([\w-]+)/)?.[1] ?? (row.ProcessId === pid ? "main" : "other");
    return { pid: row.ProcessId, kind, cpu: (Number(row.KernelModeTime) + Number(row.UserModeTime)) / 1e7, mb: Number(row.WorkingSetSize) / 1048576 };
  });
}
const byKind = (rows, key) => rows.reduce((sum, row) => ({ ...sum, [row.kind]: round((sum[row.kind] ?? 0) + row[key]) }), {});
function cpuDelta(before, after, seconds) {
  const was = new Map(before.map((row) => [row.pid, row.cpu]));
  const delta = after.map((row) => ({ ...row, cpu: row.cpu - (was.get(row.pid) ?? 0) }));
  return Object.fromEntries(Object.entries(byKind(delta, "cpu")).map(([kind, cpu]) => [kind, `${round((cpu / seconds) * 100)}%`]));
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((open, fail) => { ws.onopen = open; ws.onerror = fail; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    else pending.get(message.id)?.(message);
  };
  const on = (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]);
  const send = (method, params = {}) => new Promise((done, fail) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); fail(new Error(`${method} timed out`)); }, 120_000);
    pending.set(next, (message) => {
      clearTimeout(timer);
      pending.delete(next);
      message.error ? fail(new Error(message.error.message)) : done(message.result);
    });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, on, close: () => ws.close() };
}

async function until(read, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out: ${label}`);
}

// Instances this script started, stopped by PID (and their process tree) even when a step throws.
const live = new Set();
process.on("exit", () => {
  for (const child of live) if (child.exitCode === null) try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
});
let nextPort = 9500 + Math.floor(Math.random() * 300);
async function launch() {
  const port = nextPort++;
  const inspect = nextPort++;
  const env = { ...process.env, PIGNA_USER_DATA: profile, PIGNA_BACKGROUND: "1", PIGNA_CWD: project, PIGNA_PI_BIN: pi,
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"), FAKE_TEXT_FILE: answerFile, FAKE_CHUNK: "60" };
  for (const name of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "PIGNA_TOKEN", "PIGNA_BRIDGE"]) delete env[name];
  const started = Date.now();
  const child = spawn(electron, [...(appExe ? [] : [root]), `--remote-debugging-port=${port}`, `--inspect=${inspect}`], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  live.add(child);
  let log = "";
  child.stdout.on("data", (bytes) => { log += bytes; });
  child.stderr.on("data", (bytes) => { log += bytes; });
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith("app://pigna/")), "app window");
  const app = await connect(page.webSocketDebuggerUrl);
  const mainTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json())[0], "main inspector");
  const main = await connect(mainTarget.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  // Quit as the user would (the app saves its state and stops its pis), then make sure by PID.
  const exited = new Promise((done) => child.once("exit", done));
  const stop = async () => {
    await main.evaluate("require('electron').app.quit(), true").catch(() => {});
    app.close();
    main.close();
    await Promise.race([exited, sleep(10_000)]);
    if (child.exitCode === null) try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    await sleep(1000);
  };
  return { child, app, main, started, stop, log: () => log };
}

// Probes: event-loop lag (a 16 ms interval's overshoot), long tasks, frames and input delay; read back and reset.
const RENDER_PROBE = `(() => {
  const p = window.__perf = { lag: [], long: [], frames: 0, input: [] };
  let last = performance.now();
  let timer;
  const lag = () => { const now = performance.now(); p.lag.push(now - last - 16); last = now; };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) p.long.push(e.duration); }).observe({ type: "longtask" });
  // Frames are counted only while p.counting: a rAF loop of its own would keep the GPU and renderer busy when idle.
  p.counting = false;
  const frame = () => { p.frames++; if (p.counting) requestAnimationFrame(frame); };
  // Probes run only while counting: their own timers and frames would be the idle cost otherwise.
  p.count = (on) => {
    const was = p.counting;
    p.counting = on;
    if (on && !was) { requestAnimationFrame(frame); last = performance.now(); timer = setInterval(lag, 16); }
    if (!on) clearInterval(timer);
  };
  addEventListener("input", (e) => p.input.push(performance.now() - e.timeStamp), true);
  addEventListener("keydown", (e) => e.key === "x" && p.input.push(performance.now() - e.timeStamp), true);
  return document.visibilityState;
})()`;
const RENDER_READ = `(() => { const p = window.__perf; const r = { lag: p.lag, long: p.long, frames: p.frames, input: p.input }; p.lag = []; p.long = []; p.frames = 0; p.input = []; return r; })()`;
const MAIN_PROBE = `(() => { const p = globalThis.__perf = { lag: [] }; let last = performance.now();
  setInterval(() => { const now = performance.now(); p.lag.push(now - last - 20); last = now; }, 20).unref(); return true; })()`;
const MAIN_READ = `(() => { const r = globalThis.__perf.lag; globalThis.__perf.lag = []; return r; })()`;
const summarize = (r, mainLag, seconds) => ({
  rendererLagP95: round(pct(r.lag, 0.95)), rendererLagMax: round(Math.max(0, ...r.lag)),
  longTasks: r.long.length, longTaskTotalMs: Math.round(r.long.reduce((a, b) => a + b, 0)), longTaskMaxMs: Math.round(Math.max(0, ...r.long)),
  fps: round(r.frames / seconds), inputDelayP95: round(pct(r.input, 0.95)), inputDelayMax: round(Math.max(0, ...r.input)),
  mainLagP95: round(pct(mainLag, 0.95)), mainLagMax: round(Math.max(0, ...mainLag)),
});

async function profiled(target, name, work) {
  if (!profileDir) return work();
  await target.send("Profiler.enable");
  await target.send("Profiler.setSamplingInterval", { interval: 200 });
  await target.send("Profiler.start");
  try { return await work(); } finally {
    const { profile: cpu } = await target.send("Profiler.stop");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, `${name}.cpuprofile`), JSON.stringify(cpu));
  }
}

/** Record `ms` of Chromium's timeline in the renderer and print the time per event kind (Layout, UpdateLayoutTree, Paint, ...). */
async function trace(target, name, ms) {
  const events = [];
  const done = new Promise((resolve) => {
    target.on("Tracing.dataCollected", ({ value }) => events.push(...value));
    target.on("Tracing.tracingComplete", resolve);
  });
  await target.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "v8"] }, transferMode: "ReportEvents" });
  await sleep(ms);
  await target.send("Tracing.end");
  await done;
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, `${name}.json`), JSON.stringify({ traceEvents: events }));
  // Main-thread (CrRendererMain) complete events, by name: only top-level kinds that matter for frames.
  const mainThread = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const totals = {};
  for (const e of events) {
    if (e.ph !== "X" || e.tid !== mainThread?.tid || e.pid !== mainThread?.pid) continue;
    if (!["UpdateLayoutTree", "Layout", "Paint", "PrePaint", "Layerize", "Commit", "FunctionCall", "EventDispatch", "RunMicrotasks", "TimerFire", "FireAnimationFrame", "ParseHTML", "HitTest", "IntersectionObserverController::computeIntersections", "ResizeObserverController::DeliverObservations", "RunTask", "MajorGC", "MinorGC", "V8.GC_SCAVENGER"].includes(e.name)) continue;
    totals[e.name] = (totals[e.name] ?? 0) + e.dur / 1000;
  }
  console.log(`trace ${name} (${ms} ms): ${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")}`);
}

const key = (app, key, code, modifiers = 0, text) => Promise.all(["keyDown", "keyUp"].map((type) =>
  app.send("Input.dispatchKeyEvent", { type: type === "keyDown" && text ? "keyDown" : type, key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27 }[key], ...(text && type === "keyDown" && { text }) })));
/** What a native menu item sends the window (accelerators are native menus: CDP key events never reach them). */
const menu = (main, channel, ...args) => main.evaluate(`require("electron").BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://pigna")).webContents.send(${[channel, ...args].map((a) => JSON.stringify(a)).join(", ")}), true`);

const results = { machine: { cpus: (await import("node:os")).cpus()[0]?.model, cores: (await import("node:os")).cpus().length, mem: Math.round((await import("node:os")).totalmem() / 2 ** 30) + " GB" }, sessions: copied.length, throttle, startup: [], open: [], history: undefined, idle: undefined, streaming: [] };

// ── Startup: a priming launch (empty profile: skips first-run setup, writes the session index) then warm ones ──
{
  const instance = await launch();
  await until(() => instance.app.evaluate("Boolean(window.studio)"), "preload");
  await instance.app.evaluate("localStorage.setItem('pigna:setup-done', '1')");
  await until(() => instance.app.evaluate("window.studio.listSessions().then(() => true)"), "session index");
  await sleep(3000);
  await instance.stop();
}
for (let run = 0; run < runs; run++) {
  const instance = await launch();
  const { app } = instance;
  const paint = await until(() => app.evaluate("performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0"), "first paint");
  const origin = await app.evaluate("performance.timeOrigin");
  // Interactive: the composer is there.
  await until(() => app.evaluate("Boolean(document.querySelector('textarea'))"), "composer").catch(async (error) => {
    console.error(await app.evaluate("location.href + '\\n' + document.body.innerText.slice(0, 1500)"), instance.log().slice(-3000));
    throw error;
  });
  const interactive = Date.now();
  const window = Number(instance.log().match(/window ready (\d+) ms/)?.[1] ?? 0);
  await sleep(5000);
  const tree = processTree(instance.child.pid);
  results.startup.push({ windowReady: window, firstPaint: Math.round(origin + paint - instance.started), interactive: interactive - instance.started, mb: byKind(tree, "mb") });
  console.log(`startup #${run}: window ready ${window} ms, first paint ${Math.round(origin + paint - instance.started)} ms, composer ${interactive - instance.started} ms, memory ${JSON.stringify(byKind(tree, "mb"))} MB`);
  if (run < runs - 1) await instance.stop();
  else results.instance = instance;
}

// ── The last instance stays up for opening chats, streaming and idle ──────────────────────────────────────────────
const { app, main, child, stop: stopLast } = results.instance;
delete results.instance;
await app.evaluate(RENDER_PROBE).then((visibility) => console.log(`window visibility: ${visibility}`));
await app.evaluate("window.__perf.count(true), true");
await main.evaluate(MAIN_PROBE);
// --inject file.js: evaluated in the window before any chat opens (A/B experiments without rebuilding).
if (flag("inject")) await app.evaluate(readFileSync(flag("inject"), "utf8"));
// The window never takes OS focus (PIGNA_BACKGROUND); emulate it so CDP text input reaches the focused field.
await app.send("Emulation.setFocusEmulationEnabled", { enabled: true });
if (throttle > 1) await app.send("Emulation.setCPUThrottlingRate", { rate: throttle });
const summaries = await app.evaluate("window.studio.listSessions().then((p) => p.flatMap((x) => x.sessions ?? []).map((s) => ({ path: s.path, title: s.title })))");
const lastRun = "[...document.querySelectorAll('[data-run]')].at(-1)";
const resetProbes = async () => { await app.evaluate(RENDER_READ); await main.evaluate(MAIN_READ); };
const readProbes = async (seconds) => summarize(await app.evaluate(RENDER_READ), await main.evaluate(MAIN_READ), seconds);
const SETTLE = `window.__settle = { last: performance.now() }; window.__mo?.disconnect(); window.__mo = new MutationObserver(() => { window.__settle.last = performance.now(); }); window.__mo.observe(document.body, { subtree: true, childList: true, characterData: true }); true`;
/** The DOM stopped changing for 750 ms: when it last changed (performance.now()). */
const settled = (extra = "true") => until(() => app.evaluate(`(${extra}) && performance.now() - window.__settle.last > 750 ? window.__settle.last : 0`), "settled", 180_000);

/** Open a chat from the search palette (Enter on its title), timed to a settled transcript. */
async function openChat(file, name) {
  const summary = summaries.find((s) => s.path.toLowerCase() === file.path.toLowerCase());
  if (!summary) return console.log(`skip ${file.path}: not listed`);
  await menu(main, "studio:palette-toggle");
  await until(() => app.evaluate("Boolean(document.querySelector('dialog[open] input'))"), "palette");
  await app.send("Input.insertText", { text: summary.title.slice(0, 60) });
  await sleep(300);
  await resetProbes();
  const before = processTree(child.pid);
  await app.evaluate(SETTLE);
  const t0 = await app.evaluate("performance.now()");
  const wall = Date.now();
  const done = await profiled(app, `${name}-renderer`, () => profiled(main, `${name}-main`, async () => {
    await key(app, "Enter", "Enter", 0, "\r");
    return settled("document.querySelector('[data-run]')");
  }));
  const seconds = (Date.now() - wall) / 1000;
  const row = { chat: name, mb: round(file.bytes / 1048576), settledMs: Math.round(done - t0), runsShown: await app.evaluate("document.querySelectorAll('[data-run]').length"),
    domNodes: await app.evaluate("document.getElementsByTagName('*').length"), cpu: cpuDelta(before, processTree(child.pid), seconds), ...(await readProbes(seconds)) };
  results.open.push(row);
  console.log(`open ${name} (${row.mb} MB): settled in ${row.settledMs} ms, ${row.runsShown} turns shown, ${row.domNodes} DOM nodes, long tasks ${row.longTasks} (max ${row.longTaskMaxMs} ms, total ${row.longTaskTotalMs} ms), main lag max ${row.mainLagMax} ms`);
}

/** Page the open chat's whole history in, as scrolling back does: "Show earlier" until there is none. */
async function pageHistory() {
  await resetProbes();
  const wall = Date.now();
  const pages = [];
  await profiled(app, "history-renderer", () => profiled(main, "history-main", async () => {
    for (let page = 0; page < 500; page++) {
      await app.evaluate(SETTLE);
      const t0 = await app.evaluate("performance.now()");
      const clicked = await app.evaluate("(() => { const b = [...document.querySelectorAll('button')].find((b) => /^Show (earlier|\\d+ earlier)/.test(b.textContent.trim()) && !b.disabled); b?.click(); return Boolean(b); })()");
      if (!clicked) break;
      pages.push(Math.round((await settled()) - t0));
    }
  }));
  const seconds = (Date.now() - wall) / 1000;
  const runsShown = await app.evaluate("document.querySelectorAll('[data-run]').length");
  const domNodes = await app.evaluate("document.getElementsByTagName('*').length");
  results.history = { pages: pages.length, pageMsMedian: median(pages), pageMsMax: Math.max(0, ...pages), runsShown, domNodes, ...(await readProbes(seconds)) };
  console.log(`history: ${pages.length} pages to ${runsShown} turns (${domNodes} DOM nodes), page median ${results.history.pageMsMedian} ms / max ${results.history.pageMsMax} ms (incl. 750 ms settle), long tasks ${results.history.longTasks} (max ${results.history.longTaskMaxMs} ms, total ${results.history.longTaskTotalMs} ms)`);
}

/** Send a prompt in the shown chat and type into its composer while the answer streams: tool calls, then the long Markdown. */
async function stream(name) {
  // pi is ready once the composer names its model (Fake); a prompt sent before that waits for it.
  await until(() => app.evaluate("document.querySelector('main')?.innerText.includes('Fake') && document.querySelector('textarea')?.value === '' && (document.querySelector('textarea').focus(), true)"), "composer");
  // The newest turn changes when the run starts (the count may not: the transcript shows a fixed number of turns).
  const lastBefore = await app.evaluate(`${lastRun}?.dataset.run ?? ""`);
  const before = processTree(child.pid);
  await resetProbes();
  // Typed right before sending: a slow step in between (the process table takes a second) let a re-render drop it.
  await app.send("Input.insertText", { text: "go [tools=15][toolout=40][toolchunk=5][delay=12]" });
  await until(() => app.evaluate("document.querySelector('textarea').value.startsWith('go ')"), "prompt typed", 5000);
  const wall = Date.now();
  let typed = 0;
  const done = await profiled(app, `${name}-renderer`, () => profiled(main, `${name}-main`, async () => {
    await key(app, "Enter", "Enter", 0, "\r");
    await until(() => app.evaluate(`(${lastRun}?.dataset.run ?? "") !== ${JSON.stringify(lastBefore)}`), "run started", 20_000).catch(async (error) => {
      console.error(await app.evaluate("JSON.stringify({ textareas: [...document.querySelectorAll('textarea')].map((t) => t.value), active: document.activeElement?.tagName, focus: document.hasFocus(), main: document.querySelector('main')?.innerText.slice(0, 600) })"));
      console.error(readFileSync(join(profile, "logs", "main.log"), "utf8").split("\n").filter((l) => !/ spawn /.test(l)).slice(-40).join("\n"));
      writeFileSync(join(tmpdir(), "pigna-perf-failure.png"), Buffer.from((await app.send("Page.captureScreenshot")).data, "base64"));
      throw error;
    });
    // With --profile, also a 5 s rendering trace from the middle of the stream: where the frame time goes (style, layout, paint).
    const tracing = profileDir && sleep(8000).then(() => trace(app, `${name}-trace`, 5000));
    // A key every 150 ms, timed from the event to its handler (input delay while the transcript streams).
    for (;;) {
      await key(app, "x", "KeyX", 0, "x");
      typed++;
      await sleep(150);
      const finished = await app.evaluate(`(${lastRun}?.textContent.includes("Section 60") ?? false) && !document.querySelector('button[title^="Stop"], [aria-label="Stop"]')`);
      if (finished || Date.now() - wall > 240_000) {
        await tracing;
        return finished;
      }
    }
  }));
  const seconds = (Date.now() - wall) / 1000;
  const row = { chat: name, completed: done, seconds: round(seconds), typed, cpu: cpuDelta(before, processTree(child.pid), seconds), domNodes: await app.evaluate("document.getElementsByTagName('*').length"), ...(await readProbes(seconds)) };
  results.streaming.push(row);
  console.log(`stream in ${name}: ${row.seconds} s${done ? "" : " (DID NOT FINISH)"}, cpu ${JSON.stringify(row.cpu)}, renderer lag p95 ${row.rendererLagP95} / max ${row.rendererLagMax} ms, long tasks ${row.longTasks} (total ${row.longTaskTotalMs} ms, max ${row.longTaskMaxMs} ms), input delay p95 ${row.inputDelayP95} / max ${row.inputDelayMax} ms, fps ${row.fps}`);
  // Clear what was typed, for the next composer.
  await app.evaluate("(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
}

const big = copied.filter((file) => !file.synthetic).slice(0, openCount);
for (const [index, file] of big.entries()) await openChat(file, `chat${index + 1}`);

// ── Idle: the opened chats stay open, nothing runs ──
{
  await app.evaluate("window.__perf.count(false), true");
  await sleep(3000);
  await resetProbes();
  const before = processTree(child.pid);
  const seconds = 30;
  await sleep(seconds * 1000);
  const after = processTree(child.pid);
  // What could keep repainting an idle window: running CSS/Web animations, with their element.
  const animations = await app.evaluate(`document.getAnimations().filter((a) => a.playState === "running").map((a) => (a.animationName ?? a.constructor.name) + " on " + (a.effect?.target?.outerHTML ?? "?").slice(0, 160))`);
  if (animations.length) console.log(`running animations while idle:\n  ${animations.join("\n  ")}`);
  results.idle = { seconds, animations, cpu: cpuDelta(before, after, seconds), mb: byKind(after, "mb"), ...(await readProbes(seconds)) };
  console.log(`idle ${seconds} s with ${big.length} chats open: cpu ${JSON.stringify(results.idle.cpu)}, memory ${JSON.stringify(results.idle.mb)} MB`);
  await app.evaluate("window.__perf.count(true), true");
}

// ── Streaming, in a new chat and then in the long synthetic one with its whole history paged in ──
await menu(main, "studio:open-project", project);
await until(() => app.evaluate("!document.querySelector('[data-run]')"), "new chat");
await stream("new chat");
const long = copied.find((file) => file.synthetic);
if (long) {
  await openChat(long, `synthetic ${synthetic} turns`);
  await stream(`synthetic ${synthetic} turns, latest page`);
  await pageHistory();
  await stream(`synthetic ${synthetic} turns, history paged in`);
}

const mainLog = results.startup.length ? readFileSync(join(profile, "logs", "main.log"), "utf8") : "";
results.mainLoaded = [...mainLog.matchAll(/loaded (\d+) entries in (\d+) ms/g)].map((m) => ({ entries: Number(m[1]), ms: Number(m[2]) }));
console.log(`main read+parse of opened chats: ${JSON.stringify(results.mainLoaded)}`);
await stopLast();
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
rmSync(work, { recursive: true, force: true, maxRetries: 5 });
