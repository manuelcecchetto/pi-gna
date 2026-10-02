#!/usr/bin/env node
// Dev tool: launch the app N times in a throwaway profile and print spawn -> first contentful paint, its
// navigation/paint split and the RSS of the app's processes 5 s later, plus medians. Uses fake pi.
//   node scripts/measure-startup.mjs checkout 7 node bin/pi-studio.mjs
//   node scripts/measure-startup.mjs packaged 7 "dist/mac-arm64/pi studio.app/Contents/MacOS/pi studio"
// Each instance is stopped by its own PID. Startup times swing with machine load: compare medians taken back to back.
import { execSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [label = "run", runs = "5", command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: measure-startup.mjs <label> <runs> <command> [args...]");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 9471;
const profile = `/tmp/pi-studio-measure-${label}`;
execSync(`rm -rf '${profile}'`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function measure() {
  const started = Date.now();
  const child = spawn(command.includes("/") ? resolve(command) : command, [...args, `--remote-debugging-port=${port}`], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, PI_STUDIO_USER_DATA: profile, PI_STUDIO_BACKGROUND: "1", PI_STUDIO_CWD: root, PI_STUDIO_PI_BIN: join(root, "scripts", "fake-pi.mjs") },
  });
  try {
    let page;
    for (let i = 0; i < 300 && !page; i++) {
      await sleep(50);
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
      page = targets.find((t) => t.type === "page" && /\/index\.html$/.test(t.url));
    }
    if (!page) throw new Error("the app window never appeared");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((open) => (ws.onopen = open));
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      pending.get(message.id)?.(message.result?.result?.value);
    };
    const evaluate = (expression) =>
      new Promise((done) => {
        pending.set(++seq, done);
        ws.send(JSON.stringify({ id: seq, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      });
    let paint = 0;
    for (let i = 0; i < 200 && !paint; i++) {
      paint = await evaluate("(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1) + performance.timeOrigin");
      if (paint < performance.timeOrigin) paint = 0;
      if (!paint) await sleep(50);
    }
    const navigation = await evaluate("performance.timeOrigin");
    ws.close();
    await sleep(5000);
    const rows = execSync("ps -axo pid=,ppid=,rss=,command=").toString().trim().split("\n").map((line) => {
      const [pid, ppid, rss, ...rest] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: rest.join(" ") };
    });
    const tree = new Set([child.pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (tree.has(row.ppid) && !tree.has(row.pid)) {
          tree.add(row.pid);
          grew = true;
        }
      }
    }
    // The app's own processes: not the node launcher, not fake pi.
    const app = rows.filter((row) => tree.has(row.pid) && !/^node |fake-pi/.test(row.command));
    return { fcp: Math.round(paint - started), nav: Math.round(navigation - started), paint: Math.round(paint - navigation), rss: Math.round(app.reduce((sum, row) => sum + row.rss, 0) / 1024) };
  } finally {
    child.kill("SIGTERM");
    await new Promise((exited) => child.once("exit", exited));
    await sleep(1500);
  }
}

const results = [];
for (let run = 0; run < Number(runs); run++) {
  const result = await measure();
  results.push(result);
  console.log(`${label} #${run}  fcp ${result.fcp} ms  (nav ${result.nav} + paint ${result.paint})  rss ${result.rss} MB`);
}
const median = (key) => results.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
console.log(`${label} median  fcp ${median("fcp")} ms  (nav ${median("nav")} + paint ${median("paint")})  rss ${median("rss")} MB`);
