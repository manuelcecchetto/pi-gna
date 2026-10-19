#!/usr/bin/env node
// Dev tool: end-to-end check of the agent browser tools added for WebMCP, dialogs, uploads, select, drag, hover, scroll,
// wait_for and media emulation, through the real app. Run after `pnpm build`:
//   node scripts/verify-browser-agent.mjs
// Starts a fixture HTTP server and a throwaway app instance (fake pi, which hands its bridge token to this script),
// drives the browser_* bridge the way the agent tools do, and prints a pass/fail table. Exit code 1 on any failure.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pigna-verify-agent-"));
const port = 9488;
const inspect = 9489;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rows = [];
const check = (name, ok, detail = "") => {
  rows.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
};

const PAGE = `<!doctype html><title>agent fixture</title>
<body style="font:14px system-ui">
<h1 id=scheme>?</h1>
<p id=out>idle</p>
<button onclick="out.textContent = 'confirm:' + confirm('Delete it?')">Delete</button>
<button onclick="alert('Saved!'); out.textContent = 'alerted'">Alert</button>
<label>Size <select id=size onchange="out.textContent = 'size:' + this.value"><option value=s>Small</option><option value=l>Large</option></select></label>
<input type=file id=file multiple aria-label="Attach files" onchange="out.textContent = 'files:' + [...this.files].map((f) => f.name).join(',')">
<button onclick="avatar.click()">Choose avatar</button><input type=file id=avatar hidden onchange="out.textContent = 'avatar:' + this.files[0].name">
<div id=card draggable=true style="width:80px;height:30px;background:#c33;color:#fff">Card</div>
<div id=lane style="width:160px;height:60px;background:#ddd;margin-top:20px">Done lane</div>
<span id=hov onmouseenter="tip.hidden = false" style="padding:4px">Hover me</span><span id=tip hidden>Tooltip shown</span>
<button onclick="setTimeout(() => (late.textContent = 'Loaded results'), 800)">Load</button><p id=late></p>
<form toolname="search_flights" tooldescription="Search flights by destination" toolautosubmit><input name=to required></form>
<div style="height:3000px"></div><p>Bottom of page</p>
<script>
const mq = matchMedia("(prefers-color-scheme: dark)");
const showScheme = () => (document.getElementById("scheme").textContent = mq.matches ? "dark" : "light");
showScheme();
mq.onchange = showScheme;
card.ondragstart = (e) => e.dataTransfer.setData("text/plain", "card-1");
lane.ondragover = (e) => e.preventDefault();
lane.ondrop = (e) => { e.preventDefault(); out.textContent = "dropped:" + e.dataTransfer.getData("text/plain"); };
document.modelContext?.registerTool({
  name: "set_size",
  description: "Set the size select to Small or Large",
  inputSchema: { type: "object", properties: { size: { type: "string", enum: ["Small", "Large"] } }, required: ["size"] },
  annotations: { readOnlyHint: false },
  execute: ({ size }) => { document.getElementById("size").value = size === "Large" ? "l" : "s"; out.textContent = "tool:" + size; return "Size set to " + size; },
});
</script></body>`;
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(PAGE);
});
await new Promise((open) => server.listen(0, "127.0.0.1", open));
const base = `http://127.0.0.1:${server.address().port}/`;
writeFileSync(join(work, "a.txt"), "a");
writeFileSync(join(work, "b.txt"), "b");

const pi = join(work, "pi.mjs");
// pi-gna also runs pi for other things (model list, version) without a bridge; only a chat's pi records it.
writeFileSync(
  pi,
  `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.env.PIGNA_BRIDGE) writeFileSync(${JSON.stringify(join(work, "env.json"))}, JSON.stringify({ url: process.env.PIGNA_BRIDGE, token: process.env.PIGNA_TOKEN }));\nawait import(${JSON.stringify(join(root, "scripts", "fake-pi.mjs"))});\n`,
);
chmodSync(pi, 0o755);
const env = { ...process.env, PIGNA_USER_DATA: join(work, "profile"), PIGNA_BACKGROUND: "1", PIGNA_CWD: root, PIGNA_PI_BIN: pi };
// Launched from a pi-gna chat, this shell carries that app's bridge: the instance's pi must get its own.
delete env.PIGNA_BRIDGE;
delete env.PIGNA_TOKEN;
const app = spawn("node", [join(root, "bin", "pi-gna.mjs"), `--remote-debugging-port=${port}`, `--inspect=${inspect}`], { cwd: root, stdio: "ignore", env });

let bridge;
async function call(body, ms = 20_000) {
  const response = await Promise.race([
    fetch(`${bridge.url}/browser`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(body) }),
    sleep(ms).then(() => {
      throw new Error(`${body.action} timed out after ${ms} ms`);
    }),
  ]);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}
const attempt = (body) => call(body).then((result) => ({ result }), (error) => ({ error: error.message }));
const read = async (expression) => (await call({ action: "evaluate", expression })).text;
const refOf = (snap, pattern) => Number(new RegExp(`\\[(\\d+)\\] ${pattern}`).exec(snap.text ?? "")?.[1]);

// The main process, through Node's inspector: wraps dialog.showMessageBox to see whether a box is still open.
let mainWs;
let seq = 0;
const waiting = new Map();
async function main(expression) {
  if (!mainWs) {
    const [target] = await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json();
    mainWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((open) => (mainWs.onopen = open));
    mainWs.onmessage = (event) => {
      const message = JSON.parse(event.data);
      waiting.get(message.id)?.(message);
    };
  }
  const id = ++seq;
  const answer = new Promise((done) => waiting.set(id, done));
  mainWs.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  const message = await answer;
  if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? "main eval failed");
  return message.result?.result?.value;
}
// The app's renderer (window.studio), through the app window's CDP target.
async function renderer(expression) {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith("app://"));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open) => (ws.onopen = open));
  const answer = new Promise((done) => (ws.onmessage = (event) => done(JSON.parse(event.data))));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  const message = await answer;
  ws.close();
  if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? "renderer eval failed");
  return message.result?.result?.value;
}
const openBoxes = () => main("globalThis.__boxes.filter((box) => box.open).map((box) => box.message)");

try {
  for (let i = 0; i < 400 && !bridge; i++) {
    await sleep(100);
    try {
      bridge = JSON.parse(readFileSync(join(work, "env.json"), "utf8"));
    } catch {}
  }
  if (!bridge) throw new Error("no bridge token from the fake pi");
  await main(`(() => {
    const { dialog } = process.mainModule.require("electron");
    const show = dialog.showMessageBox.bind(dialog);
    globalThis.__boxes = [];
    dialog.showMessageBox = (...args) => {
      const options = args.length > 1 ? args[1] : args[0];
      const box = { message: options.message, open: true };
      globalThis.__boxes.push(box);
      const shown = show(...args);
      shown.finally(() => (box.open = false));
      return shown;
    };
  })()`);

  const opened = await call({ action: "open", url: base });
  const toolsPart = (opened.text ?? "").split("Page tools (WebMCP")[1] ?? "";
  check("open: snapshot lists the page's WebMCP tools (script and form)", /\n- set_size: Set the size select/.test(toolsPart) && /\n- search_flights: Search flights/.test(toolsPart), toolsPart.replace(/\n/g, " | ").slice(0, 160));
  check("open: draggable element has a ref", Number.isFinite(refOf(opened, 'div "Card"')));

  // WebMCP
  const listed = await call({ action: "page_tool" });
  check("page_tool: lists schemas", /input: \{"type":"object","properties":\{"size"/.test(listed.text ?? ""), (listed.text ?? "").slice(0, 120));
  const ran = await call({ action: "page_tool", name: "set_size", input: { size: "Large" } });
  check("page_tool: runs the tool in the page", /Result:\nSize set to Large/.test(ran.text ?? "") && (await read("out.textContent")) === "tool:Large", ran.text?.split("Result:")[1]?.trim());
  const unknown = await attempt({ action: "page_tool", name: "nope" });
  check("page_tool: unknown tool names the page's tools", /The page has: (search_flights, set_size|set_size, search_flights)\./.test(unknown.error ?? ""), unknown.error);

  // Dialogs
  let snap = await call({ action: "snapshot" });
  const confirmClick = await call({ action: "click", ref: refOf(snap, 'button "Delete"') });
  check("click → confirm: reported, not stuck", /showing a confirm dialog: "Delete it\?"/.test(confirmClick.text ?? ""), confirmClick.text?.slice(0, 80));
  check("confirm: the user sees a box", JSON.stringify(await openBoxes()) === JSON.stringify(["Delete it?"]), JSON.stringify(await openBoxes()));
  const blocked = await attempt({ action: "snapshot" });
  check("confirm: other actions are refused while it is open", /paused until the dialog is answered/.test(blocked.error ?? ""), blocked.error?.slice(0, 60));
  const accepted = await call({ action: "dialog", accept: true });
  await sleep(300);
  check("dialog accept: page gets true", /^Accepted the confirm dialog/.test(accepted.text ?? "") && (await read("out.textContent")) === "confirm:true", await read("out.textContent"));
  check("dialog accept: the user's box closed", (await openBoxes()).length === 0, JSON.stringify(await openBoxes()));
  await call({ action: "click", ref: refOf(snap, 'button "Delete"') });
  await call({ action: "dialog", accept: false });
  await sleep(300);
  check("dialog dismiss: page gets false", (await read("out.textContent")) === "confirm:false");
  await call({ action: "click", ref: refOf(snap, 'button "Alert"') });
  await call({ action: "dialog", accept: true });
  await sleep(300);
  check("alert: closed, page continues", (await read("out.textContent")) === "alerted" && (await openBoxes()).length === 0);

  // A dialog on a tab nobody sees shows no box: a box without a window stalls the main process until answered.
  await renderer("window.studio.browser.layout({ visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } })");
  await call({ action: "evaluate", expression: "setTimeout(() => (out.textContent = 'late:' + confirm('Later?')), 300); 'armed'" });
  await sleep(2500);
  const started = Date.now();
  const during = await call({ action: "state" }, 5000);
  check("off-screen dialog: no box, app stays responsive", (await openBoxes()).length === 0 && Date.now() - started < 2000, `state in ${Date.now() - started} ms`);
  await renderer("window.studio.browser.layout({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } })");
  await sleep(500);
  check("off-screen dialog: its box shows once the tab is back on screen", JSON.stringify(await openBoxes()) === JSON.stringify(["Later?"]), JSON.stringify(await openBoxes()));
  await call({ action: "dialog", accept: true });
  await sleep(300);
  check("off-screen dialog: the agent answers it, the box closes", (await openBoxes()).length === 0);
  check("off-screen dialog: the page gets the answer", (await read("out.textContent")) === "late:true", `${during.title} → ${await read("out.textContent")}`);

  // Select
  snap = await call({ action: "snapshot" });
  const select = refOf(snap, 'select "Size');
  const picked = await call({ action: "select", ref: select, values: ["Small"] });
  check("select: by label, change event fires", /Selected "Small"/.test(picked.text ?? "") && (await read("out.textContent")) === "size:s", await read("out.textContent"));
  const notSelect = await attempt({ action: "select", ref: refOf(snap, 'button "Load"'), values: ["x"] });
  check("select: refuses a non-select", /not a native <select>/.test(notSelect.error ?? ""), notSelect.error);

  // Upload
  const files = [join(work, "a.txt"), join(work, "b.txt")];
  await call({ action: "upload", ref: refOf(snap, 'file "Attach files"'), files });
  check("upload: file input gets the files", (await read("out.textContent")) === "files:a.txt,b.txt", await read("out.textContent"));
  const viaButton = await call({ action: "upload", ref: refOf(snap, 'button "Choose avatar"'), files: [files[0]] });
  check("upload: picker button, no picker opens", /file chooser/.test(viaButton.text ?? "") && (await read("out.textContent")) === "avatar:a.txt", await read("out.textContent"));

  // Drag
  const dragged = await call({ action: "drag", from: refOf(snap, 'div "Card"'), to: "#lane" });
  check("drag: HTML drag and drop onto a selector", (await read("out.textContent")) === "dropped:card-1", `${dragged.text?.slice(0, 60)} → ${await read("out.textContent")}`);

  // Hover
  await call({ action: "hover", ref: "#hov" });
  check("hover: reveals the tooltip", (await read("tip.hidden")) === "false");

  // wait_for
  snap = await call({ action: "snapshot" });
  await call({ action: "click", ref: refOf(snap, 'button "Load"') });
  const waited = await call({ action: "wait_for", text: "Loaded results", timeout: 5000 });
  check("wait_for: returns once the text appears", /^Condition met after/.test(waited.text ?? "") && /Loaded results/.test(waited.text ?? ""), waited.text?.split("\n")[0]);
  const timedOut = await attempt({ action: "wait_for", selector: ".never", timeout: 500 });
  check("wait_for: times out with what is missing", /Still waiting after 0\.5 s for a visible element matching "\.never"/.test(timedOut.error ?? ""), timedOut.error);

  // Scroll
  const scrolled = await call({ action: "scroll", deltaY: 1200 });
  const y = Number(await read("String(scrollY)"));
  check("scroll: wheel scrolls the page", y > 0 && /page scrolled to 0,/.test(scrolled.text ?? ""), `scrollY ${y}`);

  // Media emulation
  const dark = await call({ action: "emulate", set: { colorScheme: "dark" } });
  check("emulate: prefers-color-scheme dark", dark.media?.colorScheme === "dark" && (await read("scheme.textContent")) === "dark");
  const later = await call({ action: "state" });
  check("emulate: every result reports it", later.media?.colorScheme === "dark");
  const reset = await call({ action: "emulate", reset: true });
  check("emulate: reset follows the system", reset.media === undefined && ["light", "dark"].includes(await read("scheme.textContent")));
} catch (error) {
  check("run", false, error instanceof Error ? `${error.message}${error.cause ? ` (${error.cause})` : ""}` : String(error));
} finally {
  mainWs?.close();
  app.kill("SIGTERM");
  await new Promise((done) => (app.exitCode === null ? app.once("exit", done) : done()));
  server.close();
  // Keep the instance's logs when something failed (PIGNA_KEEP=1 keeps them always).
  if (process.exitCode || process.env.PIGNA_KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail ?? ""}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${rows.length} checks failed` : `\nall ${rows.length} checks passed`);
process.exit(failed ? 1 : 0);
