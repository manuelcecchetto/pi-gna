// Logging. The terminal that launched pi studio is the app's live log: main-process events, every pi child's
// stderr, and (with PI_STUDIO_DEBUG=1) all RPC traffic. The same lines go to a file (Help > Show Logs), which is
// the only log when the app is opened from Finder or the Dock.
import { createWriteStream, renameSync, statSync, type WriteStream } from "node:fs";

const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
export const debugRpc = process.env.PI_STUDIO_DEBUG === "1";

const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint("2");
const colors = [paint("36"), paint("35"), paint("33"), paint("32"), paint("34"), paint("91")];
const levelColor = { info: paint("37"), warn: paint("33"), error: paint("31") } as const;
const MAX_FILE = 5 * 1024 * 1024;
let file: WriteStream | undefined;

/** Also append to `path`; a file over 5 MB is moved to `<name>.old.log` first. */
export function logToFile(path: string): void {
  if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_FILE) renameSync(path, path.replace(/\.log$/, ".old.log"));
  file = createWriteStream(path, { flags: "a" });
  file.on("error", () => (file = undefined));
}

function time(): string {
  return dim(new Date().toTimeString().slice(0, 8));
}

function scopeColor(scope: string): (text: string) => string {
  let hash = 0;
  for (const char of scope) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length] ?? dim;
}

function write(level: keyof typeof levelColor, scope: string, message: string): void {
  const prefix = `${time()} ${scopeColor(scope)(scope.padEnd(10))}`;
  const stream = level === "error" ? process.stderr : process.stdout;
  const stamp = file && new Date().toISOString();
  for (const line of message.split("\n")) {
    stream.write(`${prefix} ${level === "info" ? line : levelColor[level](line)}\n`);
    file?.write(`${stamp} ${level.padEnd(5)} ${scope.padEnd(10)} ${line}\n`);
  }
}

export const log = {
  info: (scope: string, message: string) => write("info", scope, message),
  warn: (scope: string, message: string) => write("warn", scope, message),
  error: (scope: string, message: string) => write("error", scope, message),
  rpc(scope: string, direction: "<-" | "->", line: string): void {
    if (!debugRpc) return;
    const clipped = line.length > 600 ? `${line.slice(0, 600)}… (${line.length} chars)` : line;
    write("info", scope, `${dim(direction)} ${dim(clipped)}`);
  },
};
