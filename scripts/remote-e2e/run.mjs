#!/usr/bin/env node
// Runs the remote end-to-end scenarios in this folder (docs/REMOTE.md, "Automated end-to-end tests"): builds the app once, then
// runs each `<name>.e2e.mjs` as its own process against its own fresh instance, and prints a summary. From the repo root:
//   node scripts/remote-e2e/run.mjs [<name or prefix> ...] [--jobs <n>] [--keep] [--shots <dir>] [--list]
// `pnpm e2e:remote mobile-board reconnect` runs two scenarios; `mobile` runs every mobile-* one. A single scenario also runs
// directly (`node scripts/remote-e2e/reconnect.e2e.mjs`), building the app itself unless SLICE_E2E_APP names an earlier build.
// Exit code 0 only when every selected scenario passed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const jobs = Math.max(1, Number(option("--jobs") ?? 1));
const shots = option("--shots");
const keep = args.includes("--keep");
const names = args.filter((a, i) => !a.startsWith("--") && !["--jobs", "--shots"].includes(args[i - 1]));

const all = readdirSync(here).filter((f) => f.endsWith(".e2e.mjs")).map((f) => f.slice(0, -".e2e.mjs".length)).sort();
if (args.includes("--list")) {
  console.log(all.join("\n"));
  process.exit(0);
}
for (const name of names) if (!all.some((s) => s.startsWith(name))) throw new Error(`no scenario matches "${name}" (have: ${all.join(", ")})`);
const selected = names.length ? all.filter((s) => names.some((name) => s.startsWith(name))) : all;

const build = process.env.SLICE_E2E_APP ?? join(realpathSync(tmpdir()), `pigna-remote-e2e-build-${randomUUID().slice(0, 8)}`);
if (!process.env.SLICE_E2E_APP) {
  console.log(`building the app into ${build} ...`);
  buildApp(build);
}

const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  // Each scenario stops its own instance by PID on the signal.
  for (const child of children) child.kill(signal);
});

/** Runs one scenario; with parallel jobs its output lines carry its name. */
function run(name) {
  const started = Date.now();
  const flags = [...(keep ? ["--keep"] : []), ...(shots ? ["--shots", join(shots, name)] : [])];
  const child = spawn(process.execPath, [join(here, `${name}.e2e.mjs`), ...flags], { env: { ...process.env, SLICE_E2E_APP: build }, stdio: jobs > 1 ? ["ignore", "pipe", "pipe"] : "inherit" });
  children.add(child);
  if (jobs > 1) {
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) console.log(`[${name}] ${line}`);
      });
      stream.on("end", () => buffer && console.log(`[${name}] ${buffer}`));
    }
  }
  return new Promise((resolve) =>
    child.on("close", (code) => {
      children.delete(child);
      resolve({ name, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) });
    }),
  );
}

const queue = [...selected];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  }),
);
if (!process.env.SLICE_E2E_APP && !keep) rmSync(build, { recursive: true, force: true });

results.sort((a, b) => selected.indexOf(a.name) - selected.indexOf(b.name));
console.log("\nscenario                  result  time");
for (const r of results) console.log(`${r.name.padEnd(26)}${(r.ok ? "pass" : "FAIL").padEnd(8)}${r.seconds} s`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} scenario(s) failed: ${failed.map((r) => r.name).join(", ")}` : `\nall ${results.length} scenario(s) passed`);
process.exit(failed.length ? 1 : 0);
