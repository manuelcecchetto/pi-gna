// Maps renderer handles to pi processes and forwards their records to the window.
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { app } from "electron";
import type { HostEventBatch, OpenSessionRequest, OpenSessionResult } from "../shared/ipc";
import type { ExtensionUiResponse, RpcCommand, RpcResponse, RpcSessionState } from "../shared/protocol";
import type { AgentBridge } from "./browser/bridge";
import { log } from "./log";
import { PiProcess } from "./pi-process";
import { readActiveBranch } from "./session-file";

const HANDLE = /^[a-z0-9]{6,32}$/;
/** Tools that would compete with the integrated browser (Stagehand's). Override with PI_STUDIO_EXCLUDE_TOOLS. */
const EXCLUDED_TOOLS = process.env.PI_STUDIO_EXCLUDE_TOOLS ?? "run,snapshot,screenshot";

export class SessionHost {
  private readonly sessions = new Map<string, PiProcess>();
  private readonly extension = join(app.getAppPath(), "resources", "browser-extension.ts");

  constructor(
    private readonly emit: (batch: HostEventBatch) => void,
    private readonly bridge: AgentBridge,
  ) {}

  private piArgs(handle: string): { args: string[]; env: Record<string, string> } {
    const args = ["-e", this.extension];
    if (EXCLUDED_TOOLS) args.push("--exclude-tools", EXCLUDED_TOOLS);
    return { args, env: { PI_STUDIO_BRIDGE: this.bridge.url, PI_STUDIO_TOKEN: this.bridge.register(handle) } };
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

    const pi = new PiProcess(
      { cwd, sessionPath, tag, ...this.piArgs(handle) },
      {
        onRecords: (records) => this.emit({ handle, events: records.map((record) => ({ kind: "rpc", record })) }),
        onExit: (exit) => {
          this.sessions.delete(handle);
          this.bridge.unregister(handle);
          this.emit({ handle, events: [{ kind: "exit", ...exit }] });
        },
      },
    );
    this.sessions.set(handle, pi);

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
