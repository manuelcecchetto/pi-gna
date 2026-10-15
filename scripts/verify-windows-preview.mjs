#!/usr/bin/env node
// After pnpm build: a real Windows Electron instance, a fake pi, and a temporary profile/project.
// Pass a packaged pi-gna.exe as argv[2] to verify the installed/unpacked application instead of the checkout.
// Never drives the installed pi-gna, real models, provider settings, clipboard or native app input.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

if (process.platform !== "win32") throw new Error("Run this smoke test on Windows.");
const root = fileURLToPath(new URL("../", import.meta.url));
const packaged = process.argv[2] ? resolve(process.argv[2]) : undefined;
const electron = packaged || createRequire(import.meta.url)("electron");
const work = await mkdtemp(join(tmpdir(), "pigna windows preview-"));
const project = join(work, "Project with spaces ü");
const profile = join(work, "profile");
const agent = join(work, "agent");
const file = join(project, "docs", "a b.md");
await mkdir(join(project, "docs"), { recursive: true });
await mkdir(profile);
await mkdir(agent);
await writeFile(file, "# Windows preview smoke\n\nLocal paths work.\n");
// The fake pi's modules read repo files relative to themselves (../resources/...), so the copies keep the repo's layout.
await mkdir(join(work, "scripts"), { recursive: true });
await mkdir(join(work, "resources", "skills", "inline-visuals"), { recursive: true });
for (const name of ["fake-pi.mjs", "fake-pi-visuals.mjs"]) await copyFile(join(root, "scripts", name), join(work, "scripts", name));
await copyFile(join(root, "resources", "skills", "inline-visuals", "SKILL.md"), join(work, "resources", "skills", "inline-visuals", "SKILL.md"));
await copyFile(join(root, "resources", "icon.png"), join(work, "resources", "icon.png"));
// Exercise the same safe shim resolution as a Windows npm install of pi, without invoking cmd.exe.
const pi = join(work, "pi.cmd");
await writeFile(join(work, "pi-entry.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(work, "pi-argv.json"))}, JSON.stringify(process.argv)); await import("./scripts/fake-pi.mjs");\n`);
await writeFile(pi, '@echo off\r\nnode "%~dp0\\pi-entry.mjs" %*\r\n');
const env = {
  ...process.env, PIGNA_USER_DATA: profile, PIGNA_BACKGROUND: "1", PIGNA_CWD: project,
  PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"), PIGNA_PI_BIN: pi,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PIGNA_TOKEN;
delete env.PIGNA_BRIDGE;
const child = spawn(electron, [...(packaged ? [] : [root]), "--remote-debugging-port=0"], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (bytes) => { output += bytes; });
child.stderr.on("data", (bytes) => { output += bytes; });
let launchError;
child.on("error", (error) => { launchError = error; });
const clients = [];
let passed = false;

async function until(read, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${output}`);
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 15_000);
    pending.set(next, (message) => {
      clearTimeout(timer);
      pending.delete(next);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const client = { ws, evaluate, quit: () => ws.send(JSON.stringify({ id: ++id, method: "Browser.close" })) };
  clients.push(client);
  return client;
}

try {
  const port = await until(async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0], "DevTools port");
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = await until(async () => (await targets()).find((target) => target.url.startsWith("app://pigna/")), "app renderer");
  const app = await connect(page.webSocketDebuggerUrl);
  await until(() => app.evaluate("Boolean(window.studio)"), "preload");
  assert.equal(await app.evaluate("window.studio.launchCwd"), project);
  // Native card writes must work in the shipped build as well, not only in shared unit tests.
  await app.evaluate(`window.studio.board.apply({type:"add",id:"smoke1",title:"Windows smoke",cwd:${JSON.stringify(project)},column:"in_progress"})`);
  assert.ok((await app.evaluate("window.studio.board.get()")).cards.some((card) => card.id === "smoke1" && card.cwd === project));
  const paths = [file, "docs/a%20b.md#L1", pathToFileURL(file).href];
  assert.deepEqual(await app.evaluate(`window.studio.browser.resolvePreviewTargets(${JSON.stringify(project)}, ${JSON.stringify(paths)})`), [file, file, file]);
  const session = await app.evaluate(`window.studio.openSession({cwd:${JSON.stringify(project)}})`);
  assert.ok(session.handle, "fake pi session opened");
  const state = await app.evaluate(`window.studio.command(${JSON.stringify(session.handle)}, {type:"get_state"})`);
  assert.equal(state.success, true, `Windows shim starts pi RPC: ${JSON.stringify(state)}`);
  const piArgs = JSON.parse(await readFile(join(work, "pi-argv.json"), "utf8"));
  assert.ok(!piArgs.some((arg) => arg.includes("computer-extension")), "Computer Use extension must not be exposed on Windows");
  await app.evaluate(`window.studio.browser.preview(${JSON.stringify(file)}, {root:${JSON.stringify(project)}, line:1})`);
  const preview = await until(async () => (await targets()).find((target) => target.url.startsWith("pigna-file://")), "preview renderer");
  const viewer = await connect(preview.webSocketDebuggerUrl);
  await until(() => viewer.evaluate("Boolean(document.body?.innerText.includes('Windows preview smoke'))"), "rendered Markdown");
  const bytes = await viewer.evaluate("fetch(location.href.split('#')[0] + '?raw=1').then(r => r.text())");
  assert.match(bytes, /^# Windows preview smoke/);
  await app.evaluate(`window.studio.closeSession(${JSON.stringify(session.handle)})`);
  console.log(`PASS (${packaged ? "packaged" : "source"}): Windows Kanban, npm shim + pi RPC; native/relative/file URL links; Electron Markdown preview + raw bytes; no Computer Use extension.`);
  passed = true;
} finally {
  if (child.exitCode === null && clients.length) clients[0].quit();
  for (const { ws } of clients) ws.close();
  if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  // Only this test's process tree; never kill by executable name (the user's app may also be Electron).
  if (child.exitCode === null && child.pid) await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
  if (passed) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else {
    await writeFile(join(work, "smoke.log"), output);
    console.error(`Failure log retained at ${join(work, "smoke.log")}`);
    // The runner keeps no files, so the app's own output belongs in the log too, or a hosted failure says nothing.
    console.error(`App output (last 8000 chars):\n${output.slice(-8000)}`);
  }
}
