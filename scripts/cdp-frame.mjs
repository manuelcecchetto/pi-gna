#!/usr/bin/env node
// Dev tool: evaluate JavaScript inside an inline visual's sandboxed iframe (a separate CDP target; the app page cannot
// reach into it). Usage: CDP_PORT=9333 node scripts/cdp-frame.mjs "<expression>" [index]   (index: nth visual frame, default 0)
const port = process.env.CDP_PORT || "9333";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const frames = list.filter((t) => t.type === "iframe" && t.url.startsWith("pigna-visual:"));
const target = frames[Number(process.argv[3] || 0)];
if (!target) throw new Error(`no visual frame target (${frames.length} found)`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  console.log(JSON.stringify(message.result?.result?.value ?? message.result ?? message.error));
  process.exit(0);
};
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: process.argv[2], returnByValue: true, awaitPromise: true } }));
setTimeout(() => {
  console.error("no answer in 10 s");
  process.exit(1);
}, 10_000);
