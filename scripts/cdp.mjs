#!/usr/bin/env node
// Dev tool: drive a running pi studio over CDP. Start the app with
//   node bin/pi-studio.mjs --remote-debugging-port=9333
// then:
//   node scripts/cdp.mjs shot /tmp/studio.png          # screenshot the window
//   node scripts/cdp.mjs eval "document.title"          # evaluate in the renderer
//   node scripts/cdp.mjs type "hello" [--enter]         # type into the focused element
//   node scripts/cdp.mjs key Escape|Enter|ctrl+o        # press a key
//   node scripts/cdp.mjs click 120 340                  # real mouse click at CSS px
//   node scripts/cdp.mjs drop 600 400 /path/a /path/dir  # drop files from the OS at CSS px
//   CDP_URL=localhost:8765 node scripts/cdp.mjs shot    # target a browser tab instead of the app
// Uses Node's built-in WebSocket; no dependencies.
import { writeFileSync } from "node:fs";

const port = process.env.CDP_PORT || "9333";
const [command, ...args] = process.argv.slice(2);

// CDP_URL picks a target by URL substring (browser tabs are separate targets); default: the app window.
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const match = process.env.CDP_URL;
const page = targets.find((t) =>
  t.type === "page" && !t.url.startsWith("devtools://") && (match ? t.url.includes(match) : /\/renderer\/index\.html|localhost:5173\/?$/.test(t.url)),
);
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
};

async function press(spec) {
  const parts = spec.split("+");
  const name = parts.pop();
  const modifiers = (parts.includes("alt") ? 1 : 0) | (parts.includes("ctrl") ? 2 : 0) | (parts.includes("meta") ? 4 : 0) | (parts.includes("shift") ? 8 : 0);
  const base = KEYS[name] ?? { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...base, text: undefined });
}

switch (command) {
  case "shot": {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(args[0] ?? "/tmp/studio.png", Buffer.from(data, "base64"));
    console.log(args[0] ?? "/tmp/studio.png");
    break;
  }
  case "eval": {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression: args.join(" "), awaitPromise: true, returnByValue: true });
    console.log(exceptionDetails ? exceptionDetails.exception?.description : JSON.stringify(result.value, null, 2));
    break;
  }
  case "type": {
    const enter = args.includes("--enter");
    await send("Input.insertText", { text: args.filter((a) => a !== "--enter").join(" ") });
    if (enter) await press("Enter");
    break;
  }
  case "key":
    await press(args[0]);
    break;
  case "click": {
    const [x, y] = args.map(Number);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    break;
  }
  case "drop": {
    // Real OS-style file drop: drop <x> <y> <path...>
    const [x, y, ...files] = args;
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await send("Input.dispatchDragEvent", { type, x: Number(x), y: Number(y), data });
    }
    break;
  }
  case "targets":
    console.log(targets.filter((t) => t.type === "page").map((t) => t.url).join("\n"));
    break;
  default:
    console.error("usage: cdp.mjs shot <path> | eval <expr> | type <text> [--enter] | key <key>");
    process.exitCode = 1;
}
ws.close();
