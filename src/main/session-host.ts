// Maps renderer handles to pi processes and forwards their records to the window.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type AtpSession, isPlanPath } from "../shared/atp";
import { projectOf } from "../shared/board";
import type { HostEventBatch, OpenSessionRequest, OpenSessionResult } from "../shared/ipc";
import type { ExtensionUiResponse, RpcCommand, RpcResponse, RpcSessionState } from "../shared/protocol";
import type { AgentBridge } from "./bridge";
import { log } from "./log";
import { PiProcess } from "./pi-process";
import { projectTrust } from "./pi-settings";
import { onDisk } from "./resources";
import { readActiveBranch } from "./session-file";

/** How long an approval card waits for the user before it counts as a refusal. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const HANDLE = /^[a-z0-9]{6,32}$/;
/** Tools that would compete with the integrated browser (Stagehand's). Override with PIGNA_EXCLUDE_TOOLS. */
const EXCLUDED_TOOLS = process.env.PIGNA_EXCLUDE_TOOLS ?? "run,snapshot,screenshot";

export class SessionHost {
  private readonly sessions = new Map<string, PiProcess>();
  private readonly cwds = new Map<string, string>();
  /** Choices main asked of the user (requestChoice). Answered from the window only; pi never sees them. */
  private readonly choices = new Map<string, { handle: string; resolve: (value: string | undefined) => void }>();
  private readonly endListeners = new Set<(handle: string) => void>();
  /** The browser_*, kanban_* and lament tools, which reach pi-gna through the bridge. */
  private readonly extensions = ["browser-extension.ts", "kanban-extension.ts", "lament-extension.ts"].map((name) => onDisk("resources", name));
  /** Tells the model its replies render as Markdown in pi-gna (pi-gna sessions only, not the terminal UI). */
  private readonly prompt = onDisk("resources", "pigna-prompt.md");

  constructor(
    private readonly emit: (batch: HostEventBatch) => void,
    private readonly bridge: AgentBridge,
  ) {}
    /** Where ATP chats keep their session files, apart from pi's, so they stay out of the sidebar. */
    private readonly atpSessions: string,
    /** Read at spawn: the computer_* tools exist only in chats opened while Computer Use is enabled. */
    private readonly computerEnabled: () => Promise<boolean> = async () => false,

  /** `trust`: whether pi may load the project's own resources, when pi cannot tell from the cwd itself. */
  private piArgs(handle: string, trust: boolean | undefined, atp: AtpSession | undefined, computer: boolean): { args: string[]; env: Record<string, string> } {
    const args = [...this.extensions.flatMap((path) => ["-e", path]), "--append-system-prompt", this.prompt];
    if (EXCLUDED_TOOLS) args.push("--exclude-tools", EXCLUDED_TOOLS);
    if (computer) args.push("-e", onDisk("resources", "computer-extension.ts"));
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
      { cwd, sessionPath, tag, ...this.piArgs(handle, trust, atp) },
      {
        onRecords: (records) => {
          this.emit({ handle, events: records.map((record) => ({ kind: "rpc", record })) });
          if (records.some((record) => record.type === "agent_end" && !record.willRetry)) this.ended(handle);
        },
        onExit: (exit) => {
          this.settleChoices(handle);
          this.ended(handle);
          this.sessions.delete(handle);
          this.cwds.delete(handle);
          this.bridge.unregister(handle);
    const computer = await this.computerEnabled().catch(() => false);
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

  /** Called when a chat's run finishes (agent_end without a retry) or its pi process exits. Returns an unsubscribe. */
  onRunEnd(listener: (handle: string) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  private ended(handle: string): void {
    for (const listener of this.endListeners) {
      try {
        listener(handle);
      } catch (error) {
        log.warn("pi", `run-end listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The chat's name as the user sees it, for labels in other apps. */
  async chatName(handle: string): Promise<string | undefined> {
    const state = await this.command(handle, { type: "get_state" });
    return (state.data as RpcSessionState | undefined)?.sessionName || undefined;
  }

  /** Ask the user to pick one option on this chat's approval card. The id is main's own, so the answer is read here
   * from the window and never forwarded to pi, and nothing holding the bridge token can answer it. Undefined when
   * the user dismisses it, the wait runs out or the chat ends. */
  requestChoice(handle: string, title: string, options: string[]): Promise<string | undefined> {
    if (!this.sessions.has(handle)) return Promise.resolve(undefined);
    const id = `pigna-choice-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), APPROVAL_TIMEOUT_MS);
      const settle = (value: string | undefined) => {
        clearTimeout(timer);
        this.choices.delete(id);
        resolve(value);
      };
      this.choices.set(id, { handle, resolve: settle });
      this.emit({ handle, events: [{ kind: "rpc", record: { type: "extension_ui_request", id, method: "select", title, options, timeout: APPROVAL_TIMEOUT_MS } }] });
    });
  }

  private settleChoices(handle: string): void {
    for (const choice of [...this.choices.values()]) if (choice.handle === handle) choice.resolve(undefined);
  }

  respondUi(handle: string, response: ExtensionUiResponse): void {
    const choice = this.choices.get(response.id);
    if (choice) {
      if (choice.handle === handle) choice.resolve("value" in response ? response.value : undefined);
      return;
    }
    this.sessions.get(handle)?.respondUi(response);
  }

  async close(handle: string): Promise<void> {
    await this.sessions.get(handle)?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((pi) => pi.close()));
  }
}
