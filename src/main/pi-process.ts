// One `pi --mode rpc` child: LF-only JSONL framing, id-correlated commands, stderr to the terminal.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { ExtensionUiRequest, ExtensionUiResponse, RpcCommand, RpcOutput, RpcResponse, SessionEvent } from "../shared/protocol";
import { JsonlSplitter } from "./jsonl";
import { log } from "./log";

export interface PiProcessOptions {
  cwd: string;
  sessionPath?: string;
  /** Short label used in terminal logs. */
  tag: string;
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

const PI_BIN = process.env.PI_STUDIO_PI_BIN || "pi";
const STDERR_TAIL = 4000;

export class PiProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly stdout = new JsonlSplitter();
  private readonly stderr = new JsonlSplitter();
  private stderrTail = "";
  private seq = 0;
  private exited = false;

  constructor(
    private readonly options: PiProcessOptions,
    private readonly handlers: PiProcessHandlers,
  ) {
    const args = ["--mode", "rpc"];
    if (options.sessionPath) args.push("--session", options.sessionPath);
    log.info(options.tag, `spawn ${PI_BIN} ${args.join(" ")}  (cwd ${options.cwd})`);

    this.child = spawn(PI_BIN, args, { cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(this.stdout.push(chunk)));
    this.child.stdout.on("end", () => this.onStdout(this.stdout.end()));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(this.stderr.push(chunk)));
    this.child.stderr.on("end", () => this.onStderr(this.stderr.end()));
    this.child.stdin.on("error", (error) => log.warn(options.tag, `stdin: ${error.message}`));
    this.child.on("error", (error) => this.finish({ code: null, signal: null, error: error.message }));
    this.child.on("exit", (code, signal) => this.finish({ code, signal }));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  send<T = unknown>(command: RpcCommand): Promise<RpcResponse<T>> {
    if (this.exited) {
      return Promise.resolve({ type: "response", command: command.type, success: false, error: "pi is not running" });
    }
    const id = `s${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve: resolve as Pending["resolve"] });
      this.write({ id, ...command });
    });
  }

  respondUi(response: ExtensionUiResponse): void {
    this.write(response);
  }

  /** Orderly shutdown: close stdin, then escalate if pi does not exit. */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const term = setTimeout(() => this.child.kill("SIGTERM"), 3000);
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 6000);
      this.child.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve();
      });
      this.child.stdin.end();
    });
  }

  private write(record: object): void {
    if (this.exited || !this.child.stdin.writable) return;
    const line = JSON.stringify(record);
    log.rpc(this.options.tag, "->", line);
    this.child.stdin.write(`${line}\n`);
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
    this.exited = true;
    const reason = exit.error ?? (exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`);
    (exit.code === 0 || exit.signal === "SIGTERM" ? log.info : log.warn)(this.options.tag, `pi exited (${reason})`);
    for (const [id, pending] of this.pending) {
      pending.resolve({ type: "response", id, command: "unknown", success: false, error: "pi exited" });
    }
    this.pending.clear();
    this.handlers.onExit({ ...exit, stderrTail: this.stderrTail });
  }
}
