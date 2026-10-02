// pi extension: `pi --studio` opens pi studio in the current directory instead of the terminal UI.
// Installed through this repo's package.json `pi` manifest (`pi install ~/Code/personal/pi-studio`).
// It hands the terminal to pi studio (which keeps logging there) and exits pi with studio's exit code.
// In every other pi process, including studio's own `pi --mode rpc` children, it only registers the flag.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));

export default async function (pi: ExtensionAPI) {
  pi.registerFlag("studio", { type: "boolean", description: "Open pi studio (desktop UI) in this directory instead of the terminal UI" });
  // Flag values are not available to factories yet, and the hand-off must happen before the TUI starts.
  if (!process.argv.slice(2).includes("--studio")) return;

  const child = spawn(process.execPath, [join(here, "..", "bin", "pi-studio.mjs")], { cwd: process.cwd(), stdio: "inherit", env: process.env });
  // Stay alive until studio has shut its pi sessions down; pass signals on (studio's quit is idempotent).
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    child.on("error", (error) => {
      console.error(`pi --studio: ${error.message}`);
      resolve(1);
    });
  });
  process.exit(code);
}
