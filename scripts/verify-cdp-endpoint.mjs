#!/usr/bin/env node
// Dev tool: end-to-end check of the chat CDP endpoint ($PIGNA_CDP, src/main/browser/cdp-endpoint.ts) through the real
// app. Run after `pnpm build`:
//   node scripts/verify-cdp-endpoint.mjs            raw CDP client checks
//   node scripts/verify-cdp-endpoint.mjs --keep     leave the instance running and print its PIGNA_CDP (for browser-use)
// Starts a fixture HTTP server and a throwaway app instance (fake pi, which hands its bridge and CDP URL to this
// script), drives the endpoint like a CDP client and prints a pass/fail table. Exit code 1 on any failure.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "pigna-verify-cdp-"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rows = [];
const check = (name, ok, detail = "") => {
  rows.push({ name, ok, detail });
  if (!ok) process.exitCode = 1;
};

const PAGE = `<!doctype html><title>cdp fixture</title><body><button id=b onclick="out.textContent='clicked'" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Click me</button><p id=out style="margin-top:80px">idle</p></body>`;
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(PAGE);
});
await new Promise((open) => server.listen(0, "127.0.0.1", open));
const fixture = `http://127.0.0.1:${server.address().port}/`;

const pi = join(work, "pi.mjs");
// pi-gna also runs pi for other things (model list, version) without a bridge; only a chat's pi records it.
writeFileSync(
  pi,
  `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.env.PIGNA_BRIDGE) writeFileSync(${JSON.stringify(join(work, "env.json"))}, JSON.stringify({ url: process.env.PIGNA_BRIDGE, token: process.env.PIGNA_TOKEN, cdp: process.env.PIGNA_CDP }));\nawait import(${JSON.stringify(join(root, "scripts", "fake-pi.mjs"))});\n`,
);
chmodSync(pi, 0o755);
const env = { ...process.env, PIGNA_USER_DATA: join(work, "profile"), PIGNA_BACKGROUND: "1", PIGNA_CWD: root, PIGNA_PI_BIN: pi };
// Launched from a pi-gna chat, this shell carries that app's bridge: the instance's pi must get its own.
delete env.PIGNA_BRIDGE;
delete env.PIGNA_TOKEN;
delete env.PIGNA_CDP;
const app = spawn("node", [join(root, "bin", "pi-gna.mjs")], { cwd: root, stdio: "ignore", env });

/** A minimal CDP client: `send` resolves with the reply (or its error), `events` collects everything else. */
async function connect(url, options) {
  const ws = new WebSocket(url, options);
  const replies = new Map();
  const events = [];
  let seq = 0;
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = () => fail(new Error("refused"));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) replies.get(message.id)?.(message);
    else events.push(message);
  };
  const send = (method, params = {}, sessionId) =>
    Promise.race([
      new Promise((done) => {
        const id = ++seq;
        replies.set(id, done);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      sleep(15_000).then(() => ({ error: { message: `${method} timed out` } })),
    ]);
  return { ws, send, events };
}

let bridge;
try {
  for (let i = 0; i < 400 && !bridge; i++) {
    await sleep(100);
    try {
      bridge = JSON.parse(readFileSync(join(work, "env.json"), "utf8"));
    } catch {}
  }
  if (!bridge?.cdp) throw new Error("no PIGNA_CDP from the fake pi");
  check("pi gets PIGNA_CDP", bridge.cdp === `${bridge.url.replace("http:", "ws:")}/cdp/${bridge.token}`, bridge.cdp.replace(bridge.token, "<token>"));

  const refused = async (url, options) => connect(url, options).then((client) => (client.ws.close(), false), () => true);
  check("wrong token refused", await refused(`${bridge.url.replace("http:", "ws:")}/cdp/nope`));
  check("a web page (Origin) refused", await refused(bridge.cdp, { headers: { origin: "https://example.com" } }));

  const { send, events } = await connect(bridge.cdp);
  const version = await send("Browser.getVersion");
  check("Browser.getVersion", /^Chrome\//.test(version.result?.product ?? ""), version.result?.product);

  const created = await send("Target.createTarget", { url: "about:blank", background: true });
  const targetId = created.result?.targetId;
  check("Target.createTarget opens a pane tab", !!targetId, JSON.stringify(created.error ?? ""));
  const targets = (await send("Target.getTargets")).result?.targetInfos ?? [];
  check("targets are the chat's tabs only (no app window)", targets.length === 1 && targets[0].targetId === targetId && targets[0].type === "page", JSON.stringify(targets.map((t) => t.url)));

  const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result?.sessionId;
  check("Target.attachToTarget (flatten)", !!sessionId);
  await send("Page.enable", {}, sessionId);
  const navigated = await send("Page.navigate", { url: fixture }, sessionId);
  check("Page.navigate", !navigated.error, JSON.stringify(navigated.error ?? ""));
  for (let i = 0; i < 50 && !events.some((event) => event.method === "Page.loadEventFired" && event.sessionId === sessionId); i++) await sleep(100);
  check("page events carry the session id", events.some((event) => event.method === "Page.loadEventFired" && event.sessionId === sessionId));

  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.result?.value;
  check("Runtime.evaluate", (await evaluate("document.title")) === "cdp fixture");
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 80, y: 40, button: "left", clickCount: 1 }, sessionId);
  check("Input.dispatchMouseEvent clicks", (await evaluate("out.textContent")) === "clicked");
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  check("Page.captureScreenshot", (shot.result?.data?.length ?? 0) > 1000, `${shot.result?.data?.length ?? 0} base64 chars ${JSON.stringify(shot.error ?? "")}`);
  const escape = await send("Target.getTargets", {}, sessionId);
  check("Target.* refused on a page session", escape.error?.code === -32601);

  const state = await (await fetch(`${bridge.url}/browser`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ action: "state" }) })).json();
  check("the tab is the chat's tab in pi-gna", (state.url ?? "").startsWith(fixture), state.url);

  if (keep) {
    console.log(`\nKept running (app pid ${app.pid}). PIGNA_CDP=${bridge.cdp}\nStop with: kill ${app.pid}`);
  } else {
    const closed = await send("Target.closeTarget", { targetId });
    check("Target.closeTarget", closed.result?.success === true);
    for (let i = 0; i < 20 && !events.some((event) => event.method === "Target.detachedFromTarget"); i++) await sleep(100);
    check("closing the tab detaches its session", events.some((event) => event.method === "Target.detachedFromTarget" && event.params.sessionId === sessionId));
  }
} catch (error) {
  check("run", false, error.message);
} finally {
  console.table(rows.map(({ name, ok, detail }) => ({ check: name, result: ok ? "PASS" : "FAIL", detail })));
  server.close();
  if (!keep) {
    app.kill();
    await sleep(500);
    rmSync(work, { recursive: true, force: true });
    process.exit();
  }
}
