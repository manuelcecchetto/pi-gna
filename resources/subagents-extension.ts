// pi extension loaded into every pi-gna chat: the chat's subagents (@gotgenes/pi-subagents, a recommended package), live.
// The package runs its agents inside this pi and publishes a service on globalThis; once a second this reads its
// records and, when they changed, reports them as the `pigna-subagents` extension status (src/shared/subagents.ts),
// which reaches every client with the chat. What an agent does now is its session file's latest tool call. `/subagent
// stop|steer <id>` is how the clients stop or steer one. Without the package nothing is reported and the command says so.
// The service is taken at session_start, once every factory ran: a child session loads the package again, which
// publishes the child's own (empty) service over the chat's and removes it when the child ends (pi-subagents 23).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { encodeSubagents, parseSubagentCommand, shortArgs, SUBAGENTS_STATUS, type Subagent, type SubagentStatus, type SubagentStep } from "../src/shared/subagents";

/** pi-subagents' SubagentRecord (its public service API), the fields read here. */
interface AgentRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  lifetimeUsage?: { input?: number; output?: number; cacheWrite?: number };
  outputFile?: string;
}

interface SubagentsService {
  listAgents(): AgentRecord[];
  abort(id: string): boolean;
  steer(id: string, message: string): Promise<boolean>;
}

const SERVICE = Symbol.for("@gotgenes/pi-subagents:service");
const service = (): SubagentsService | undefined => (globalThis as Record<symbol, unknown>)[SERVICE] as SubagentsService | undefined;

/** The newest agents reported; older ones stay in the chat's files. */
const MAX_AGENTS = 24;
/** How much of a session file's end is read for the latest tool call and model. */
const TAIL_BYTES = 64 * 1024;
const TICK_MS = 1000;

/** The latest tool call and model in the end of a session file. */
export function readTail(text: string): { last?: SubagentStep; model?: string } {
  const lines = text.split("\n");
  let model: string | undefined;
  // The first line may be cut; it is skipped when it does not parse.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"role":"assistant"')) continue;
    let entry: { message?: { role?: string; provider?: string; model?: string; content?: { type: string; name?: string; arguments?: Record<string, unknown> }[] } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    model ??= message.provider && message.model ? `${message.provider}/${message.model}` : undefined;
    const call = message.content?.findLast((block) => block.type === "toolCall" && typeof block.name === "string");
    if (call) return { last: { name: call.name!, args: shortArgs(call.arguments ?? {}) }, model };
  }
  return { model };
}

function tail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function toSubagent(record: AgentRecord, read: (path: string) => string = tail): Subagent {
  const usage = record.lifetimeUsage ?? {};
  const { last, model } = record.outputFile ? readTail(read(record.outputFile)) : {};
  return {
    id: record.id,
    description: record.description,
    type: record.type,
    status: record.status as SubagentStatus,
    startedAt: record.startedAt,
    toolUses: record.toolUses,
    tokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0),
    ...(record.completedAt !== undefined && { endedAt: record.completedAt }),
    ...(record.outputFile && { file: record.outputFile }),
    ...(model && { model }),
    ...(last && { last }),
    ...(record.error && { error: record.error }),
  };
}

export default function (pi: ExtensionAPI) {
  /** The session's context: a session replacement brings a new one (session_start). */
  let ctx: ExtensionContext | undefined;
  /** The chat's pi-subagents service, as published when the session started. */
  let agents: SubagentsService | undefined;
  let reported: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const report = () => {
    const records = agents?.listAgents();
    if (!ctx || !records) return;
    const text = records.length ? encodeSubagents(records.slice(0, MAX_AGENTS).map((record) => toSubagent(record))) : undefined;
    if (text === reported) return;
    reported = text;
    ctx.ui.setStatus(SUBAGENTS_STATUS, text);
  };
  const tick = () => {
    try {
      report();
    } catch {
      // A record the package changed shape of: the next tick tries again; the chat goes on.
    }
  };
  pi.on("session_start", (_event, next) => {
    ctx = next;
    agents = service();
    reported = undefined;
    tick();
    timer ??= setInterval(tick, TICK_MS);
    timer.unref?.();
  });
  pi.on("tool_execution_end", tick);
  pi.on("agent_end", tick);
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx = undefined;
    agents = undefined;
  });

  pi.registerCommand("subagent", {
    description: "Stop or steer a subagent: /subagent stop <id>, /subagent steer <id> <message>",
    handler: async (args, commandCtx) => {
      const parsed = parseSubagentCommand(args);
      if (!parsed) return commandCtx.ui.notify("Usage: /subagent stop <id> | /subagent steer <id> <message>", "warning");
      if (!agents) return commandCtx.ui.notify("Subagents are not installed in this chat (pi-subagents).", "warning");
      if (parsed.action === "stop") {
        if (!agents.abort(parsed.id)) commandCtx.ui.notify("That subagent is not running.", "warning");
      } else if (!(await agents.steer(parsed.id, parsed.message))) {
        commandCtx.ui.notify("That subagent is not running, so it cannot be steered.", "warning");
      }
      report();
    },
  });
}
