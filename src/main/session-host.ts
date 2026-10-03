// Maps renderer handles to pi processes and forwards their records to the window.
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { app } from "electron";
import { projectOf } from "../shared/board";
import type { HostEventBatch, OpenSessionRequest, OpenSessionResult } from "../shared/ipc";
import type { ExtensionUiResponse, RpcCommand, RpcResponse, RpcSessionState } from "../shared/protocol";
import type { AgentBridge } from "./bridge";
import { log } from "./log";
import { PiProcess } from "./pi-process";
import { projectTrust } from "./pi-settings";
import { readActiveBranch } from "./session-file";

const HANDLE = /^[a-z0-9]{6,32}$/;
/** Files pi reads from disk. Packaged builds keep them beside app.asar, in app.asar.unpacked (electron-builder asarUnpack). */
const onDisk = (...parts: string[]) => join(app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"), ...parts);
/** Tools that would compete with the integrated browser (Stagehand's). Override with PIGNA_EXCLUDE_TOOLS. */
const EXCLUDED_TOOLS = process.env.PIGNA_EXCLUDE_TOOLS ?? "run,snapshot,screenshot";

export class SessionHost {
  private readonly sessions = new Map<string, PiProcess>();
  private readonly cwds = new Map<string, string>();
  /** The browser_*, kanban_* and lament tools, which reach pi-gna through the bridge. */
  private readonly extensions = ["browser-extension.ts", "kanban-extension.ts", "lament-extension.ts"].map((name) => onDisk("resources", name));
  /** Tells the model its replies render as Markdown in pi-gna (pi-gna sessions only, not the terminal UI). */
  private readonly prompt = onDisk("resources", "pigna-prompt.md");

  constructor(
    private readonly emit: (batch: HostEventBatch) => void,
    private readonly bridge: AgentBridge,
  ) {}

  /** `trust`: whether pi may load the project's own resources, when pi cannot tell from the cwd itself. */
  private piArgs(handle: string, trust: boolean | undefined): { args: string[]; env: Record<string, string> } {
    const args = [...this.extensions.flatMap((path) => ["-e", path]), "--append-system-prompt", this.prompt];
    if (EXCLUDED_TOOLS) args.push("--exclude-tools", EXCLUDED_TOOLS);
    if (trust !== undefined) args.push(trust ? "--approve" : "--no-approve");
    return { args, env: { PIGNA_BRIDGE: this.bridge.url, PIGNA_TOKEN: this.bridge.register(handle) } };
  }

  get size(): number {
    return this.sessions.size;
  }

  async open(request: OpenSessionRequest): Promise<OpenSessionResult> {
    const { handle, cwd, sessionPath } = request;
    if (!HANDLE.test(handle) || this.sessions.has(handle)) throw new Error("invalid session handle");
    if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new Error(`not a directory: ${cwd}`);
    if (sessionPath !== undefined && (!isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl"))) throw new Error("invalid session path");

    const started = Date.now();
    const entries = sessionPath ? await readActiveBranch(sessionPath) : [];
    const tag = `pi·${handle.slice(0, 4)}`;
    if (sessionPath) log.info(tag, `loaded ${entries.length} entries in ${Date.now() - started} ms`);
    // pi looks up your trust in a project by the cwd's folders, and a card's worktree lives outside the project.
    const project = projectOf(cwd);
    const trust = project === cwd ? undefined : await projectTrust(project);

    const pi = new PiProcess(
      { cwd, sessionPath, tag, ...this.piArgs(handle, trust) },
      {
        onRecords: (records) => this.emit({ handle, events: records.map((record) => ({ kind: "rpc", record })) }),
        onExit: (exit) => {
          this.sessions.delete(handle);
          this.cwds.delete(handle);
          this.bridge.unregister(handle);
          this.emit({ handle, events: [{ kind: "exit", ...exit }] });
        },
      },
    );
    this.sessions.set(handle, pi);
    this.cwds.set(handle, cwd);

    void pi.send<RpcSessionState>({ type: "get_state" }).then((response) => {
      if (!response.success || !response.data) return;
      log.info(tag, `ready in ${Date.now() - started} ms  (${response.data.model?.provider}/${response.data.model?.id}, ${response.data.thinkingLevel})`);
      this.emit({ handle, events: [{ kind: "ready", state: response.data }] });
    });
    return { entries };
  }

  command(handle: string, command: RpcCommand): Promise<RpcResponse> {
    const pi = this.sessions.get(handle);
    if (!pi) return Promise.resolve({ type: "response", command: command.type, success: false, error: "session is not running" });
    return pi.send(command);
  }

  /**
   * The chat behind a bridge request: its project and pi's current session file (asked live, since /new, /resume
   * and forks switch files). pi answers commands while one of its tools waits on the bridge.
   */
  async identify(handle: string): Promise<{ path: string; cwd: string }> {
    const cwd = this.cwds.get(handle);
    if (!cwd) throw new Error("session is not running");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("pi did not report its session file")), 5000)));
    const state = await Promise.race([this.command(handle, { type: "get_state" }), timeout]).finally(() => clearTimeout(timer));
    const path = (state.data as RpcSessionState | undefined)?.sessionFile;
    if (!path) throw new Error("this chat has no session file, so it cannot be on the board");
    return { path, cwd };
  }

  respondUi(handle: string, response: ExtensionUiResponse): void {
    this.sessions.get(handle)?.respondUi(response);
  }

  async close(handle: string): Promise<void> {
    await this.sessions.get(handle)?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((pi) => pi.close()));
  }
}
