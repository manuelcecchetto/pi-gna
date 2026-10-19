// A chat's subagents (@gotgenes/pi-subagents, a recommended package), as the sidebar, the transcript and the subagent
// view show them. Two sources make one list:
// - live: resources/subagents-extension.ts reads the package's service in the chat's pi and publishes the agents as the
//   `pigna-subagents` extension status (JSON, below); stopping and steering one go back as `/subagent stop|steer`.
// - disk: pi-subagents keeps each agent's session at `<chat file without .jsonl>/tasks/<ts>_<id>.jsonl`. The host
//   (src/main/subagents.ts) joins those files to the chat's `subagent` calls (`joinSubagents`): a child's first user
//   message is the spawning call's `prompt`, and a resume appends its prompt to the same file.
import type { SlashCommand } from "./protocol";

export const SUBAGENTS_STATUS = "pigna-subagents";

/** pi-subagents' statuses, and `unknown` for a file whose run has no recorded outcome (its chat closed mid-run). */
export type SubagentStatus = "queued" | "running" | "completed" | "aborted" | "stopped" | "error" | "unknown";

/** A tool call, enough to say what an agent is doing ("Ran pnpm test"); string arguments are cut short. */
export interface SubagentStep {
  name: string;
  args: Record<string, unknown>;
}

export interface Subagent {
  /** pi-subagents' agent id; a file no call claims has its session id. */
  id: string;
  description: string;
  /** The agent type the call named (`general-purpose`, `Explore`, a custom agent). */
  type: string;
  /** `provider/id`. */
  model?: string;
  status: SubagentStatus;
  /** Its session file, once the agent's session exists. */
  file?: string;
  startedAt: number;
  endedAt?: number;
  toolUses: number;
  /** Input, output and cache-write tokens over its life (cache reads are left out, as pi-subagents does). */
  tokens: number;
  /** Its latest tool call. */
  last?: SubagentStep;
  error?: string;
  /** The chat's `subagent` calls that spawned or resumed it, oldest first (disk only). */
  calls?: string[];
}

/**
 * A subagent's transcript as the host reads it from its file: the chat state's `items`, `modelRef`, `thinkingLevel` and
 * `cwd`. Opaque here, as host-api keeps the chat state (session-state.ts imports host-api); clients cast it.
 */
export interface SubagentTranscript {
  items: unknown[];
  modelRef?: { provider: string; modelId: string };
  thinkingLevel?: string;
  cwd: string;
}

export const isActive = (status: SubagentStatus): boolean => status === "running" || status === "queued";
export const isFailure = (status: SubagentStatus): boolean => status === "error" || status === "aborted";

const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "completed", "aborted", "stopped", "error", "unknown"]);

/** The extension's status text: the agents, newest first. */
export function encodeSubagents(agents: Subagent[]): string {
  return JSON.stringify({ v: 1, agents });
}

/** The live agents a chat's extension status holds; none when it holds nothing readable. */
export function liveSubagents(text: string | undefined): Subagent[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { v?: unknown; agents?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.agents)) return [];
    return parsed.agents.filter(
      (agent): agent is Subagent =>
        Boolean(agent) && typeof agent.id === "string" && typeof agent.description === "string" && STATUSES.has(agent.status),
    );
  } catch {
    return [];
  }
}

/**
 * One list from both sources, newest first: the live record wins for what changes while an agent runs, the file for
 * what only the chat's history knows (its calls, and the model the call result named).
 */
export function mergeSubagents(disk: readonly Subagent[], live: readonly Subagent[]): Subagent[] {
  const byId = new Map(disk.map((agent) => [agent.id, agent]));
  const byFile = new Map(disk.flatMap((agent) => (agent.file ? [[agent.file, agent] as const] : [])));
  const merged = new Map(disk.map((agent) => [agent.id, agent]));
  for (const agent of live) {
    const known = byId.get(agent.id) ?? (agent.file ? byFile.get(agent.file) : undefined);
    if (known) merged.delete(known.id);
    merged.set(agent.id, known ? { ...known, ...agent, model: agent.model ?? known.model, calls: known.calls, file: agent.file ?? known.file } : agent);
  }
  return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** The agent a `subagent`, `get_subagent_result` or `steer_subagent` call is about, from its arguments and result. */
export function agentOfCall(
  agents: readonly Subagent[],
  call: { id: string; name: string; arguments: Record<string, unknown> },
  details: unknown,
): Subagent | undefined {
  const fromResult = details && typeof details === "object" ? (details as { agentId?: unknown }).agentId : undefined;
  const id = typeof fromResult === "string" ? fromResult : [call.arguments.resume, call.arguments.agent_id].find((value): value is string => typeof value === "string");
  if (id) return agents.find((agent) => agent.id === id);
  const byCall = agents.find((agent) => agent.calls?.includes(call.id));
  if (byCall || call.name !== "subagent") return byCall;
  // A foreground run reports no id until it ends; a running agent with its description that no other call claims stands in.
  const description = call.arguments.description;
  return agents.find((agent) => agent.description === description && isActive(agent.status) && !agent.calls?.some((id) => id !== call.id));
}

/**
 * The prompt that stops or steers an agent. pi renames commands that share a name, so the clients find pi-gna's by
 * the file that registered it (as fastCommand does). pi runs an extension command at once, even mid-run.
 */
export function subagentCommand(commands: readonly SlashCommand[] | undefined, action: "stop", id: string): string;
export function subagentCommand(commands: readonly SlashCommand[] | undefined, action: "steer", id: string, message: string): string;
export function subagentCommand(commands: readonly SlashCommand[] | undefined, action: "stop" | "steer", id: string, message?: string): string {
  const ours = commands?.find((command) => command.source === "extension" && /[\\/]subagents-extension\.ts$/.test(command.sourceInfo?.path ?? ""));
  return `/${ours?.name ?? "subagent"} ${action} ${id}${action === "steer" ? ` ${message ?? ""}` : ""}`;
}

/** `/subagent stop <id>` or `/subagent steer <id> <message>`, as the extension reads its arguments. */
export function parseSubagentCommand(args: string): { action: "stop"; id: string } | { action: "steer"; id: string; message: string } | undefined {
  const match = /^\s*(stop|steer)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(args);
  if (!match) return undefined;
  const [, action, id, rest] = match;
  if (action === "stop") return { action, id: id! };
  const message = rest?.trim();
  return message ? { action: "steer", id: id!, message } : undefined;
}

/** String arguments cut to `max` characters: a step names a command or a path, not a file's contents. */
export function shortArgs(args: Record<string, unknown>, max = 240): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = value.length > max ? `${value.slice(0, max)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

// ── Disk ─────────────────────────────────────────────────────────────────────

/** A `subagent` call of the parent chat, with what its result said. */
export interface SpawnCall {
  callId: string;
  at: number;
  args: { description?: string; subagent_type?: string; prompt?: string; resume?: string; model?: string };
  /** The result's details: `agentId`, `modelName` and, for a foreground run, its final `status`. */
  result?: { agentId?: string; modelName?: string; status?: string; error?: string };
}

/** What the parent chat's file says about its subagents. */
export interface ParentFacts {
  spawns: SpawnCall[];
  /** pi-subagents' `subagents:record` entries, one per finished run (a resumed agent has several). */
  records: { id: string; status: string; startedAt?: number; completedAt?: number; error?: string }[];
  /** `get_subagent_result` details that name the agent's session file. */
  transcripts: { agentId: string; path: string }[];
}

/** What a subagent's own session file says. */
export interface ChildFacts {
  file: string;
  /** The file's session id. */
  id: string;
  startedAt: number;
  /** The user messages: the spawning prompt, then each resume's. */
  prompts: string[];
  model?: string;
  toolUses: number;
  tokens: number;
  last?: SubagentStep;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "aborted", "stopped", "error"]);

/** The parent's subagents as its files tell them, newest first. */
export function joinSubagents(parent: ParentFacts, children: readonly ChildFacts[]): Subagent[] {
  const agents = new Map<string, Subagent>();
  const unclaimed = new Map(children.map((child) => [child.file, child]));
  const transcript = new Map(parent.transcripts.map((entry) => [entry.agentId, entry.path]));
  const fill = (agent: Subagent, child: ChildFacts) => {
    unclaimed.delete(child.file);
    Object.assign(agent, { file: child.file, startedAt: child.startedAt, toolUses: child.toolUses, tokens: child.tokens, last: child.last, model: agent.model ?? child.model });
  };

  for (const spawn of parent.spawns) {
    const resumed = spawn.args.resume ? agents.get(spawn.args.resume) : undefined;
    if (resumed) {
      resumed.calls!.push(spawn.callId);
      continue;
    }
    const id = spawn.result?.agentId ?? spawn.args.resume ?? `call:${spawn.callId}`;
    const status = spawn.result?.status && TERMINAL.has(spawn.result.status) ? (spawn.result.status as SubagentStatus) : "unknown";
    const agent: Subagent = {
      id,
      description: spawn.args.description?.trim() || "Subagent",
      type: spawn.args.subagent_type || "general-purpose",
      model: spawn.result?.modelName ?? spawn.args.model,
      status,
      startedAt: spawn.at,
      toolUses: 0,
      tokens: 0,
      ...(spawn.result?.error && { error: spawn.result.error }),
      calls: [spawn.callId],
    };
    agents.set(id, agent);
    const named = transcript.get(id);
    const prompt = spawn.args.prompt?.trim();
    const child = (named && unclaimed.get(named)) ?? (prompt ? [...unclaimed.values()].find((file) => file.prompts[0]?.trim() === prompt) : undefined);
    if (child) fill(agent, child);
  }

  for (const record of parent.records) {
    const agent = agents.get(record.id);
    if (!agent || !STATUSES.has(record.status)) continue;
    agent.status = record.status as SubagentStatus;
    agent.endedAt = record.completedAt;
    if (record.error) agent.error = record.error;
    else delete agent.error;
  }
  // A resume's run has no outcome yet when its last call came after the agent's last record.
  for (const agent of agents.values()) {
    const lastCall = parent.spawns.find((spawn) => spawn.callId === agent.calls!.at(-1));
    if (lastCall && agent.calls!.length > 1 && agent.endedAt !== undefined && lastCall.at > agent.endedAt) {
      agent.status = "unknown";
      agent.endedAt = undefined;
    }
  }

  // Files no call claims (a call cut from the branch, a spawn through the package's API): named by their prompt.
  for (const child of unclaimed.values()) {
    agents.set(child.id, {
      id: child.id,
      description: firstLine(child.prompts[0] ?? "") || "Subagent",
      type: "general-purpose",
      model: child.model,
      status: "unknown",
      file: child.file,
      startedAt: child.startedAt,
      toolUses: child.toolUses,
      tokens: child.tokens,
      last: child.last,
    });
  }
  return [...agents.values()].sort((a, b) => b.startedAt - a.startedAt);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
