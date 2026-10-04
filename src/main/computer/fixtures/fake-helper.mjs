// Fake "pi-gna Computer Use" helper for tests: speaks the helper's JSON-RPC protocol (src/shared/computer.ts) over a
// Unix socket with canned apps, records every call (one JSON line per request) to --log, and needs no macOS permissions.
// Test hooks: type_text "__esc__" sends the `cancelled` notification for the overlay's session and never answers.
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
const [socketPath, token, log] = [arg("socket"), arg("token"), arg("log")];

const APPS = [
  { id: "com.example.Notes", bundleId: "com.example.Notes", displayName: "Notes", isRunning: true, pid: 101 },
  { id: "com.example.Calc", bundleId: "com.example.Calc", displayName: "Calc", isRunning: true, pid: 102 },
  { id: "com.apple.Terminal", bundleId: "com.apple.Terminal", displayName: "Terminal", isRunning: true, pid: 103 },
];
const ELEMENTS = 5;
const states = new Map(); // bundleId -> revision
const overlays = new Map(); // bundleId -> session
const find = (ref) => {
  const key = typeof ref === "string" ? ref : ref?.bundleId;
  return APPS.find((a) => a.bundleId === key || a.displayName.toLowerCase() === String(key).toLowerCase());
};
const fail = (code, message) => ({ error: { code, message } });

function handle(method, params, socket) {
  const app = find(params.app);
  switch (method) {
    case "hello":
      return { result: { helperVersion: 1, protocol: 1, os: "26.0", arch: "arm64", pid: process.pid, permissions: { accessibility: true, screenRecording: true } } };
    case "list_apps":
      return { result: { apps: APPS } };
    case "resolve_app":
      return app ? { result: { bundleId: app.bundleId, displayName: app.displayName, pid: app.pid } } : fail(-32002, `No app "${params.app}"`);
    case "overlay_show":
      if (app) overlays.set(app.bundleId, params.session);
      return { result: {} };
    case "overlay_hide":
      overlays.delete(params.app?.bundleId);
      return { result: {} };
    case "screenshot":
      return { result: { jpeg: "/9j/FAKE", width: 100, height: 80, scale: 2 } };
    case "get_app_state": {
      if (!app) return fail(-32002, "app not found");
      const first = !states.has(app.bundleId) || params.disable_diff === true;
      const revision = (states.get(app.bundleId) ?? 0) + (first ? 1 : 0);
      states.set(app.bundleId, revision);
      const text = first ? `${app.displayName} window\n0 button Save\n1 text field\n2 button Cancel\n3 checkbox\n4 list` : `diff: rev ${revision}`;
      return { result: { text, mode: first ? "full" : "diff", bundleId: app.bundleId, pid: app.pid, windowId: 1, focusedWindowTitle: app.displayName, revision, elementCount: ELEMENTS } };
    }
    case "type_text":
      if (params.text === "__esc__") {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cancelled", params: { app: app?.bundleId, session: overlays.get(app?.bundleId), reason: "esc" } })}\n`);
        return undefined;
      }
    // fall through
    case "click":
    case "drag":
    case "scroll":
    case "press_key":
    case "set_value":
    case "select_text":
    case "perform_secondary_action":
    case "paste":
      if (!app) return fail(-32002, "app not found");
      if (params.element_index !== undefined && params.element_index >= ELEMENTS) return fail(-32004, `Element ${params.element_index} is stale; call get_app_state again.`);
      states.set(app.bundleId, (states.get(app.bundleId) ?? 0) + 1);
      return { result: { method: "ax", settled: true } };
    case "shutdown":
      setTimeout(() => process.exit(0), 10);
      return { result: {} };
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

createServer((socket) => {
  let buffer = "";
  let authed = false;
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (log) appendFileSync(log, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`);
      let reply;
      if (!authed && (msg.method !== "hello" || msg.params?.token !== token)) reply = fail(-32600, "unauthorized");
      else {
        authed = true;
        reply = handle(msg.method, msg.params ?? {}, socket);
      }
      if (reply) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply })}\n`);
    }
  });
}).listen(socketPath);
process.on("SIGTERM", () => process.exit(0));
