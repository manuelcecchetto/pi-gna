#!/usr/bin/env node
// Launches pi-gna with this terminal as its log: main-process logs and every pi child's
// stderr print here. Ctrl-C quits. PIGNA_DEBUG=1 also prints all RPC traffic.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "out", "main", "index.js"))) {
  console.error("pi-gna is not built yet: run `pnpm build` in", root);
  process.exit(1);
}

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env, PIGNA_CWD: process.cwd() };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: "inherit", env });
// Ctrl-C reaches the whole foreground process group; Electron shuts its pi children down.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
