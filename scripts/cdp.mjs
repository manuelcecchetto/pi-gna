#!/usr/bin/env node
// Dev tool: drive a running pi-gna over CDP. Start the app with
//   node bin/pi-gna.mjs --remote-debugging-port=9333
// then:
//   node scripts/cdp.mjs shot /tmp/pigna.png          # screenshot the window
//   node scripts/cdp.mjs eval "document.title"          # evaluate in the renderer
//   node scripts/cdp.mjs type "hello" [--enter]         # type into the focused element
//   node scripts/cdp.mjs key Escape|Enter|ctrl+o        # press a key
//   node scripts/cdp.mjs click 120 340                  # real mouse click at CSS px
//   node scripts/cdp.mjs rightclick 120 340             # real right click (context menus)
//   node scripts/cdp.mjs drop 600 400 /path/a /path/dir  # drop files from the OS at CSS px
//   node scripts/cdp.mjs drag 268 400 360 400 [x y ...] # real mouse drag through waypoints (resize handles)
//   CDP_URL=localhost:8765 node scripts/cdp.mjs shot    # target a browser tab instead of the app
// The main process, through Node's inspector (start the app with --inspect=9334 too, CDP_MAIN=9334):
//   node scripts/cdp.mjs main "require('electron').app.getName()"  # evaluate in main (`require` works)
//   node scripts/cdp.mjs menus                          # record native menus instead of showing them; list them
//   node scripts/cdp.mjs menu "Copy Image"              # click an item of the last recorded menu
//   node scripts/cdp.mjs capture /tmp/pigna.png          # screenshot the window from main, even while it is covered
//   CDP_SCHEME=light node scripts/cdp.mjs shot          # render with prefers-color-scheme light (or dark)
// Uses Node's built-in WebSocket; no dependencies.
import { writeFileSync } from "node:fs";

const port = process.env.CDP_PORT || "9333";
const [command, ...args] = process.argv.slice(2);

// CDP_URL picks a target by URL substring (browser tabs are separate targets); default: the app window.
const inMain = ["main", "menus", "menu", "capture"].includes(command);
const targets = await (await fetch(`http://127.0.0.1:${inMain ? process.env.CDP_MAIN || "9334" : port}/json/list`)).json();
const match = process.env.CDP_URL;
const page = inMain
  ? targets[0]
  : targets.find((t) =>
      t.type === "page" && !t.url.startsWith("devtools://") && (match ? t.url.includes(match) : /^app:\/\/pigna\/|localhost:5173\/?$/.test(t.url)),
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
// Node's WebSocket does not keep the process alive while it waits: without the timer, a reply that waits for a frame
// (a screenshot of a hidden background window) let Node exit with code 13 and no output.
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no answer in 60 s`));
    }, 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

// CDP_FOCUS=1: the page behaves as focused (background test windows never are), so :focus styles render.
if (process.env.CDP_FOCUS === "1" && !inMain) await send("Emulation.setFocusEmulationEnabled", { enabled: true });
// CDP_SCHEME=light|dark: emulate the system theme. Emulation ends when this script detaches, so it only
// holds for the command it is set with.
if (process.env.CDP_SCHEME && !inMain) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.CDP_SCHEME }] });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
};

/**
 * Evaluate in the target; in main, with the console's `require`. As the DevTools console (replMode): every run shares the
 * page's global scope, and a `const` or `let` a previous run declared can be declared again. A throw exits 1.
 */
async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, includeCommandLineAPI: inMain, awaitPromise: true, returnByValue: true, replMode: true });
  if (exceptionDetails) {
    console.error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    process.exitCode = 1;
  } else console.log(JSON.stringify(result.value, null, 2));
}

// Native menus pop up on screen and CDP cannot reach them: Menu.popup records them instead, from the first `menus`.
const RECORD_MENUS = `(() => {
  if (!globalThis.__menus) {
    globalThis.__menus = [];
    require("electron").Menu.prototype.popup = function () { globalThis.__menus.push(this); };
  }
  return globalThis.__menus;
})()`;

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
    // shot <path> [x y width height scale]: close-up of a region (CSS px)
    const [x, y, width, height, scale] = args.slice(1).map(Number);
    const clip = width ? { x, y, width, height, scale: scale || 3 } : undefined;
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(args[0] ?? "/tmp/pigna.png", Buffer.from(data, "base64"));
    console.log(args[0] ?? "/tmp/pigna.png");
    break;
  }
  case "capture": {
    // A test window behind other windows counts as hidden and draws no frames, so `shot` waits forever; main can ask
    // for a frame anyway (stayHidden). Device pixels, so twice the CSS size on a Retina screen.
    const path = args[0] ?? "/tmp/pigna.png";
    await evaluate(`((require) => (async () => {
      const window = require("electron").BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith("devtools:"));
      // The first capture after a change can still be the frame before it.
      await window.webContents.capturePage(undefined, { stayHidden: true });
      const image = await window.webContents.capturePage(undefined, { stayHidden: true });
      require("fs").writeFileSync(${JSON.stringify(path)}, image.toPNG());
      return ${JSON.stringify(path)};
    })())(require)`);
    break;
  }
  case "eval":
  case "main":
    await evaluate(args.join(" "));
    break;
  case "menus":
    await evaluate(`${RECORD_MENUS}.map((menu) => menu.items.map((item) => item.type === "separator" ? "—" : item.enabled ? item.label : \`\${item.label} (disabled)\`).join(" | "))`);
    break;
  case "menu":
    await evaluate(`(() => {
      const item = ${RECORD_MENUS}.at(-1)?.items.find((other) => other.label === ${JSON.stringify(args.join(" "))});
      if (!item) return "no such item in the last recorded menu";
      item.click();
      return \`clicked \${item.label}\`;
    })()`);
    break;
  case "type": {
    const enter = args.includes("--enter");
    await send("Input.insertText", { text: args.filter((a) => a !== "--enter").join(" ") });
    if (enter) await press("Enter");
    break;
  }
  case "key":
    await press(args[0]);
    break;
  case "click":
  case "rightclick": {
    const [x, y] = args.map(Number);
    const button = command === "click" ? "left" : "right";
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
    }
    break;
  }
  case "drag": {
    // Real mouse drag: drag <x1> <y1> <x2> <y2>
    const points = [];
    const nums = args.map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
    const [[x1, y1]] = points;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
    for (let p = 1; p < points.length; p++) {
      const [ax, ay] = points[p - 1];
      const [bx, by] = points[p];
      for (let i = 1; i <= 8; i++) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax + ((bx - ax) * i) / 8, y: ay + ((by - ay) * i) / 8, button: "left", buttons: 1 });
      }
    }
    const [xe, ye] = points.at(-1);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: xe, y: ye, button: "left", clickCount: 1 });
    break;
  }
  case "move":
    // Hover: move <x> <y>
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(args[0]), y: Number(args[1]) });
    break;
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
