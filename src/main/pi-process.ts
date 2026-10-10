// One `pi --mode rpc` process: LF-only JSONL framing, id-correlated commands, stderr to the terminal.
//
// On macOS and Linux pi talks through two named pipes (FIFOs) in a folder of its own, not through pipes owned by
// pi-gna: pi holds both FIFOs open for reading and writing itself, so it never sees its stdin end or its stdout break
// when pi-gna goes away. A restart hands the chat over (`detach`, then `PiProcess.attach` in the next pi-gna) and pi
// keeps running through it. That is the Beta setting "Keep chats running on restart"; without it, and on Windows (no
// FIFOs), pi is an ordinary stdio child and stops with pi-gna.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ExtensionUiRequest, ExtensionUiResponse, RpcCommand, RpcOutput, RpcResponse, SessionEvent } from "../shared/protocol";
import { resolveCommand } from "./command";
import { JsonlSplitter } from "./jsonl";
import { log } from "./log";

export interface PiProcessOptions {
  cwd: string;
  sessionPath?: string;
  /** Short label used in terminal logs. */
  tag: string;
  args?: string[];
  env?: Record<string, string>;
  /** Talk through FIFOs, so pi can outlive pi-gna and be handed over at a restart (where `CAN_DETACH`). */
  detachable?: boolean;
}

export interface PiExit {
  code: number | null;
  signal: string | null;
  error?: string;
  stderrTail: string;
}

export interface PiProcessHandlers {
  onRecords(records: (SessionEvent | ExtensionUiRequest)[]): void;
  onExit(exit: PiExit): void;
}

interface Pending {
  resolve(response: RpcResponse): void;
}

/** What the next pi-gna needs to take a running pi over: its FIFO folder, its pid and the line it was cut in. */
export interface PiIo {
  dir: string;
  pid: number;
  /** The bytes of a record whose LF had not come yet, base64. */
  partial: string;
}

const PI_BIN = process.env.PIGNA_PI_BIN || "pi";
const STDERR_TAIL = 4000;
/** How often a pi that is not pi-gna's child is checked for being alive, and stderr read. */
const POLL_MS = 1000;
/** Whether pi talks through FIFOs, and so can outlive pi-gna. */
export const CAN_DETACH = process.platform !== "win32";

/** Where the FIFO folders live: pi-gna sets its profile's (`index.ts`), before any pi starts. */
export const piIo = { root: join(tmpdir(), "pigna-pi-io") };

/** Whether `pid` is a live `pi --mode rpc` (and not another process that got its pid since). */
export function isPi(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes("--mode rpc");
  } catch {
    return false;
  }
}

/** Open a FIFO without blocking: one end missing (pi gone) throws instead of waiting. */
const openFifo = (path: string, flags: number) => openSync(path, flags | constants.O_NONBLOCK);

function spawnError(error: NodeJS.ErrnoException): string {
  if (error.code !== "ENOENT") return error.message;
  return `\`${PI_BIN}\` was not found on your PATH. Install pi with \`npm install -g @earendil-works/pi-coding-agent\`, or set PIGNA_PI_BIN to its path.`;
}

export class PiProcess {
  /** pi when pi-gna started it; one taken over from the last pi-gna is no child of this one. */
  private child?: ChildProcess;
  /** Unset when pi could not start. */
  private input?: Writable;
  private output?: Readable;
  private piPid?: number;
  /** The FIFO folder (macOS, Linux): `in`, `out`, `err` and `pid`. */
  private dir?: string;
  /** Our read end of `out`, read directly for what is left once pi exited (a FIFO reports no end on macOS). */
  private outFd?: number;
  private errFd?: number;
  private errAt = 0;
  private poll?: ReturnType<typeof setInterval>;
  /** The bytes since the last LF: a handover passes them on, since the splitter's decoder may hold half a character. */
  private tail: Buffer[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly stdout = new JsonlSplitter();
  private readonly stderr = new JsonlSplitter();
  private stderrTail = "";
  /** Command ids differ per process object: a reply meant for the last pi-gna must not resolve one of ours. */
  private readonly ids = `${randomBytes(3).toString("hex")}-`;
  private seq = 0;
  private exited = false;
  private closing = false;
  private readonly gone: Promise<void>;
  private settled!: () => void;

  constructor(
    private readonly options: PiProcessOptions,
    private readonly handlers: PiProcessHandlers,
    /** Take over a pi a previous pi-gna started (`PiProcess.attach`), instead of starting one. */
    io?: PiIo,
  ) {
    this.gone = new Promise((resolve) => (this.settled = resolve));
    if (io) {
      this.take(io);
      return;
    }
    const args = ["--mode", "rpc", ...(options.args ?? [])];
    if (options.sessionPath) args.push("--session", options.sessionPath);
    log.info(options.tag, `spawn ${PI_BIN} ${args.join(" ")}  (cwd ${options.cwd})`);

    const env = { ...process.env, ...options.env };
    const command = resolveCommand(PI_BIN, args, env);
    if (CAN_DETACH && options.detachable) this.spawnFifo(command, env);
    else {
      const child = spawn(command.file, command.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      this.input = child.stdin;
      this.output = child.stdout;
      this.piPid = child.pid;
      child.stderr.on("data", (chunk: Buffer) => this.onStderr(this.stderr.push(chunk)));
      child.stderr.on("end", () => this.onStderr(this.stderr.end()));
      this.listen();
    }
    this.child!.on("error", (error: NodeJS.ErrnoException) => this.finish({ code: null, signal: null, error: spawnError(error) }));
    this.child!.on("exit", (code, signal) => this.finish({ code, signal }));
  }

  /** A pi the last pi-gna handed over (`detach`); undefined when it is gone. */
  static attach(io: PiIo, options: Pick<PiProcessOptions, "cwd" | "tag">, handlers: PiProcessHandlers): PiProcess | undefined {
    if (!isPi(io.pid)) return undefined;
    try {
      return new PiProcess(options, handlers, io);
    } catch (error) {
      log.warn(options.tag, `could not take pi ${io.pid} over: ${(error as Error).message}`);
      return undefined;
    }
  }

  private spawnFifo(command: { file: string; args: string[] }, env: NodeJS.ProcessEnv): void {
    mkdirSync(piIo.root, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(piIo.root, "pi-"));
    this.dir = dir;
    execFileSync("/usr/bin/mkfifo", ["-m", "600", join(dir, "in"), join(dir, "out")]);
    // pi's own ends, read-write: it is a writer of its stdin and a reader of its stdout, so neither ever closes on it.
    const fds = [openSync(join(dir, "in"), "r+"), openSync(join(dir, "out"), "r+"), openSync(join(dir, "err"), "a")];
    try {
      // detached: pi leads its own process group, so nothing sent to pi-gna's reaches it.
      this.child = spawn(command.file, command.args, { cwd: this.options.cwd, env, stdio: fds, detached: true });
    } finally {
      for (const fd of fds) closeSync(fd);
    }
    this.piPid = this.child.pid;
    // No pid: pi did not start, and the child's error event says why.
    if (!this.piPid) return;
    writeFileSync(join(dir, "pid"), String(this.piPid));
    this.connect(dir, 0);
    this.poll = setInterval(() => this.readStderr(), POLL_MS);
    this.poll.unref?.();
  }

  private take(io: PiIo): void {
    this.dir = io.dir;
    this.piPid = io.pid;
    const errSize = statSync(join(io.dir, "err")).size;
    this.connect(io.dir, Math.max(0, errSize - STDERR_TAIL));
    // The last of what it said before, for the exit card, without logging it again.
    this.stderrTail = this.readErr();
    const partial = Buffer.from(io.partial, "base64");
    if (partial.length) this.onStdout(this.read(partial));
    log.info(this.options.tag, `took pi ${io.pid} over`);
    // Not our child: its exit shows as the pid going away.
    this.poll = setInterval(() => {
      this.readStderr();
      if (!isAlive(io.pid)) this.finish({ code: null, signal: null });
    }, POLL_MS);
  }

  /** Our ends of the FIFOs. Opening `in` for writing fails when pi has it no more, so a dead pi throws here. */
  private connect(dir: string, errAt: number): void {
    const inFd = openFifo(join(dir, "in"), constants.O_WRONLY);
    this.outFd = openFifo(join(dir, "out"), constants.O_RDONLY);
    this.errFd = openSync(join(dir, "err"), "r");
    this.errAt = errAt;
    this.input = new Socket({ fd: inFd, readable: false, writable: true });
    this.output = new Socket({ fd: this.outFd, readable: true, writable: false });
    this.listen();
  }

  private listen(): void {
    if (!this.input || !this.output) return;
    this.output.on("data", (chunk: Buffer) => this.onStdout(this.read(chunk)));
    this.output.on("end", () => this.onStdout(this.stdout.end()));
    this.output.on("error", (error) => log.warn(this.options.tag, `stdout: ${error.message}`));
    // The socket closes its fd: never read that number again, another file may get it.
    this.output.on("close", () => (this.outFd = undefined));
    this.input.on("error", (error) => log.warn(this.options.tag, `stdin: ${error.message}`));
  }

  /** Split a chunk of stdout into records, keeping the bytes after its last LF for a handover. */
  private read(chunk: Buffer): string[] {
    const lf = chunk.lastIndexOf(0x0a);
    if (lf < 0) this.tail.push(chunk);
    else this.tail = lf + 1 < chunk.length ? [chunk.subarray(lf + 1)] : [];
    return this.stdout.push(chunk);
  }

  private readStderr(): void {
    const text = this.readErr();
    if (text) this.onStderr(this.stderr.push(text));
  }

  /** What pi wrote to its `err` file since the last read. */
  private readErr(): string {
    if (this.errFd === undefined) return "";
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const size = readSync(this.errFd, buffer, 0, buffer.length, this.errAt);
      if (size <= 0) break;
      this.errAt += size;
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  get pid(): number | undefined {
    return this.piPid;
  }

  send<T = unknown>(command: RpcCommand): Promise<RpcResponse<T>> {
    if (this.exited) {
      return Promise.resolve({ type: "response", command: command.type, success: false, error: "pi is not running" });
    }
    const id = `${this.ids}${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve: resolve as Pending["resolve"] });
      this.write({ id, ...command });
    });
  }

  respondUi(response: ExtensionUiResponse): void {
    this.write(response);
  }

  /**
   * Orderly shutdown, escalating if pi does not exit. A stdio child stops at the end of its stdin; a FIFO's never ends
   * (pi writes to it too), so that pi gets SIGTERM, which it handles the same way.
   */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    this.closing = true;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (this.piPid) process.kill(this.piPid, name);
      } catch {
        // gone already
      }
    };
    const fifo = this.dir !== undefined;
    const term = setTimeout(() => signal("SIGTERM"), fifo ? 0 : 3000);
    const kill = setTimeout(() => signal("SIGKILL"), fifo ? 3000 : 6000);
    if (!fifo) this.input?.end();
    return this.gone.finally(() => {
      clearTimeout(term);
      clearTimeout(kill);
    });
  }

  /**
   * Let go of pi without stopping it, for the next pi-gna to take over (`PiProcess.attach`): what we sent is written,
   * what pi said up to here is read and handled, and the rest waits in the FIFO. Undefined when pi cannot outlive us
   * (Windows) or is gone.
   */
  async detach(): Promise<PiIo | undefined> {
    if (this.exited || !this.dir || !this.piPid || !this.input || !this.output) return undefined;
    const { input, output } = this;
    if (input.writableLength) await Promise.race([new Promise((resolve) => input.once("drain", resolve)), this.gone, sleep(2000)]);
    if (this.exited) return undefined;
    // Synchronous from here: no read can land between the last record handled and the cut.
    output.pause();
    let chunk: Buffer | null;
    while ((chunk = output.read() as Buffer | null) !== null) this.onStdout(this.read(chunk));
    const io: PiIo = { dir: this.dir, pid: this.piPid, partial: Buffer.concat(this.tail).toString("base64") };
    this.exited = true;
    clearInterval(this.poll);
    this.child?.removeAllListeners("exit");
    this.child?.unref();
    output.destroy();
    input.destroy();
    if (this.errFd !== undefined) closeSync(this.errFd);
    for (const [id, pending] of this.pending) pending.resolve({ type: "response", id, command: "unknown", success: false, error: "pi-gna restarted" });
    this.pending.clear();
    log.info(this.options.tag, `handed pi ${io.pid} over`);
    return io;
  }

  private write(record: object): void {
    if (this.exited || !this.input?.writable) return;
    const line = JSON.stringify(record);
    log.rpc(this.options.tag, "->", line);
    this.input.write(`${line}\n`);
  }

  private onStdout(lines: string[]): void {
    const batch: (SessionEvent | ExtensionUiRequest)[] = [];
    for (const line of lines) {
      log.rpc(this.options.tag, "<-", line);
      let record: RpcOutput;
      try {
        record = JSON.parse(line) as RpcOutput;
      } catch {
        log.warn(this.options.tag, `non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      if (record.type === "response") {
        const pending = record.id ? this.pending.get(record.id) : undefined;
        if (pending && record.id) {
          this.pending.delete(record.id);
          pending.resolve(record);
        } else if (!record.success) {
          log.warn(this.options.tag, `${record.command}: ${record.error ?? "failed"}`);
        }
        continue;
      }
      if (record.type === "extension_error") {
        log.error(this.options.tag, `extension ${record.extensionPath} (${record.event}): ${record.error}`);
      } else if (record.type === "extension_ui_request" && record.method === "notify") {
        log.info(this.options.tag, `notify ${record.notifyType ?? "info"}: ${record.message}`);
      }
      batch.push(record);
    }
    if (batch.length) this.handlers.onRecords(batch);
  }

  private onStderr(lines: string[]): void {
    for (const line of lines) {
      log.info(this.options.tag, line);
      this.stderrTail = (this.stderrTail + line + "\n").slice(-STDERR_TAIL);
    }
  }

  private finish(exit: Omit<PiExit, "stderrTail">): void {
    if (this.exited) return;
    if (this.dir) this.drainFifo();
    this.exited = true;
    clearInterval(this.poll);
    const reason = exit.error ?? (exit.signal ? `signal ${exit.signal}` : exit.code === null ? "gone" : `code ${exit.code}`);
    (exit.code === 0 || exit.signal === "SIGTERM" || this.closing ? log.info : log.warn)(this.options.tag, `pi exited (${reason})`);
    for (const [id, pending] of this.pending) {
      pending.resolve({ type: "response", id, command: "unknown", success: false, error: "pi exited" });
    }
    this.pending.clear();
    this.settled();
    this.handlers.onExit({ ...exit, stderrTail: this.stderrTail });
  }

  /** pi exited: read what it wrote last (a FIFO's end never shows on macOS), then remove its folder. */
  private drainFifo(): void {
    const buffer = Buffer.alloc(64 * 1024);
    try {
      for (;;) {
        const size = this.outFd === undefined ? 0 : readSync(this.outFd, buffer);
        if (size <= 0) break;
        this.onStdout(this.read(Buffer.from(buffer.subarray(0, size))));
      }
    } catch {
      // EAGAIN: nothing left
    }
    this.onStdout(this.stdout.end());
    this.readStderr();
    this.onStderr(this.stderr.end());
    this.output?.destroy();
    this.input?.destroy();
    if (this.errFd !== undefined) closeSync(this.errFd);
    this.errFd = undefined;
    rmSync(this.dir!, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
