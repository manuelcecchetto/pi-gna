// ATP plans: the Agent Task Protocol's `.atp.json` graphs (github.com/manuelcecchetto/atp), which pi-gna draws on
// the ATP page and runs like atp-runner does: claim the next READY node, give it to a fresh worker chat, which
// completes, fails or decomposes it itself, commit, repeat. Plans are only ever changed through the bundled
// librarian CLI (resources/atp/skills/atp-local-librarian), never by writing the file.

export const NODE_STATUSES = ["LOCKED", "READY", "CLAIMED", "COMPLETED", "FAILED"] as const;
export type AtpNodeStatus = (typeof NODE_STATUSES)[number];
export const PROJECT_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type AtpProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface AtpNode {
  id: string;
  title: string;
  instruction: string;
  context?: string;
  dependencies: string[];
  status: AtpNodeStatus;
  /** A node a worker decomposed: it holds `children` and closes when they are all done. */
  scope: boolean;
  children: string[];
  /** ATP v1.4: replanning closed or superseded this future node; it is never run. */
  closed?: "CLOSED" | "SUPERSEDED";
  worker?: string;
  startedAt?: string;
  completedAt?: string;
  report?: string;
  artifacts: string[];
  effort?: string;
}

export interface AtpPlan {
  path: string;
  name: string;
  status: AtpProjectStatus;
  /** In file order, which is the order the architect wrote them in. */
  nodes: AtpNode[];
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** A plan as the librarian wrote it. Lenient about extra or odd fields (the protocol grows); throws when it is no plan. */
export function parsePlan(path: string, raw: unknown): AtpPlan {
  const graph = raw as { meta?: Record<string, unknown>; nodes?: Record<string, Record<string, unknown>> } | null;
  if (!graph || typeof graph !== "object" || !graph.nodes || typeof graph.nodes !== "object" || Array.isArray(graph.nodes)) throw new Error("not an ATP plan: no nodes");
  const meta = graph.meta ?? {};
  const status = PROJECT_STATUSES.find((value) => value === meta.project_status) ?? "DRAFT";
  const ids = new Set(Object.keys(graph.nodes));
  const nodes: AtpNode[] = [];
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (!node || typeof node !== "object") continue;
    const future = node.future_state;
    nodes.push({
      id,
      title: text(node.title) || id,
      instruction: text(node.instruction) ?? "",
      context: text(node.context) || undefined,
      // A dependency on a node that is not in the plan would make the layout (and the librarian) choke.
      dependencies: strings(node.dependencies).filter((dep) => ids.has(dep) && dep !== id),
      status: NODE_STATUSES.find((value) => value === node.status) ?? "LOCKED",
      scope: node.type === "SCOPE",
      children: strings(node.scope_children).filter((child) => ids.has(child)),
      closed: future === "CLOSED" || future === "SUPERSEDED" ? future : undefined,
      worker: text(node.worker_id),
      startedAt: text(node.started_at),
      completedAt: text(node.completed_at),
      report: text(node.report) || undefined,
      artifacts: strings(node.artifacts),
      effort: text(node.reasoning_effort),
    });
  }
  return { path, name: text(meta.project_name) || planName(path), status, nodes };
}

/** "auth-upgrade" for /repo/plans/auth-upgrade.atp.json. */
export const planName = (path: string): string => (path.split("/").at(-1) ?? path).replace(/\.atp\.json$/, "");

export interface AtpProgress {
  /** Nodes a worker runs: not scopes (they close themselves) and not closed by replanning. */
  total: number;
  completed: number;
  failed: number;
  claimed: number;
  ready: number;
  locked: number;
}

export function planProgress(plan: Pick<AtpPlan, "nodes">): AtpProgress {
  const progress: AtpProgress = { total: 0, completed: 0, failed: 0, claimed: 0, ready: 0, locked: 0 };
  for (const node of plan.nodes) {
    if (node.scope || node.closed) continue;
    progress.total++;
    progress[node.status === "COMPLETED" ? "completed" : node.status === "FAILED" ? "failed" : node.status === "CLAIMED" ? "claimed" : node.status === "READY" ? "ready" : "locked"]++;
  }
  return progress;
}

/** Nodes being worked on right now: claimed and not a scope (a scope stays CLAIMED until its children are done). */
export const workingNodes = (plan: Pick<AtpPlan, "nodes">): AtpNode[] => plan.nodes.filter((node) => node.status === "CLAIMED" && !node.scope && !node.closed);

/** What `atp-claim-task` answered. */
export type AtpClaim =
  | { kind: "assigned"; node: string; title: string; /** The librarian's packet: instruction, context, dependency reports. */ packet: string }
  | { kind: "none"; message: string }
  | { kind: "inactive"; message: string }
  /** The plan's orchestrator paused it (atp_pause): no new node is claimed until it resumes. */
  | { kind: "held"; message: string };

export function parseClaim(stdout: string): AtpClaim {
  const out = stdout.trim();
  const assigned = out.match(/^TASK ASSIGNED: (\S+) - (.*)$/m);
  if (assigned?.[1] && assigned.index === 0) return { kind: "assigned", node: assigned[1], title: (assigned[2] ?? "").trim(), packet: out };
  if (out.startsWith("NO_TASKS_AVAILABLE")) return { kind: "none", message: out };
  if (out.startsWith("Project is not ACTIVE")) return { kind: "inactive", message: out };
  throw new Error(`unexpected answer from atp-claim-task: ${out.slice(0, 300)}`);
}

/**
 * The models and the runner's settings, fixed until pi-gna has settings. Like atp-runner's defaults: one worker per
 * plan, a commit per node. Workers claim as WORKER_AGENT, so a restarted run gets back the node it was working on.
 */
export const ATP_CONFIG = {
  orchestrator: { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "high" },
  worker: { provider: "anthropic", id: "claude-sonnet-5-5", thinking: "medium" },
  workers: 1,
  commitPerNode: true,
  agentId: "pigna-w1",
} as const;

/** An ATP chat: a plan's worker (one node) or its orchestrator. Both live in their own session folder, off the sidebar. */
export interface AtpSession {
  role: "worker" | "orchestrator";
  /** The plan it is about; a new plan's orchestrator has none until the architect writes it. */
  plan?: string;
  /** A worker's node. */
  node?: string;
}

export const isPlanPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && path.endsWith(".atp.json") && !path.includes("\0");

/** The project's plans as main found them; a plan that cannot be read has an error instead. */
export interface AtpPlanFile {
  path: string;
  modifiedAt: number;
  plan?: AtpPlan;
  error?: string;
}

export interface AtpProjectPlans {
  cwd: string;
  plans: AtpPlanFile[];
}

/** git in the project before a node runs, to tell whether its worker committed. */
export interface AtpHead {
  sha: string | null;
  branch: string;
}

/** POST /atp on the agent bridge (resources/atp-extension.ts): the orchestrator's pause and resume. */
export interface AtpBridgeRequest {
  action: "pause" | "resume";
  plan: string;
}

/** The first message of a node's worker chat: atp-runner's runtime preamble and the claim packet. */
export function workerMessage(runtime: {
  project: string;
  plan: string;
  branch: string;
  librarian: string;
  claim: Extract<AtpClaim, { kind: "assigned" }>;
  /** The node was claimed by an earlier run that stopped before finishing it. */
  resumed?: boolean;
}): string {
  const { claim } = runtime;
  const cli = `python3 '${runtime.librarian}'`;
  return [
    "### Runtime Context (Injected by pi-gna's ATP runner)",
    `- project_root: ${runtime.project}`,
    `- plan_path: ${runtime.plan}`,
    `- agent_id: ${ATP_CONFIG.agentId}`,
    `- working_directory: ${runtime.project}`,
    `- git_branch: ${runtime.branch || "(not a git repository)"}`,
    `- librarian: ${cli} <command> --plan-path '${runtime.plan}' ...`,
    "",
    "### Claimed Task Packet",
    `- claimed_node_id: ${claim.node}`,
    `- claimed_node_title: ${claim.title}`,
    "- The runner has already claimed exactly one node for you. Do not run atp-claim-task in this turn.",
    "- If you complete or decompose this node, stop. The runner claims the next node in a fresh chat.",
    `- For more graph context use: ${cli} atp-read-graph --plan-path '${runtime.plan}' --view-mode local --node-id '${claim.node}'`,
    ...(runtime.resumed
      ? ["- An earlier run of this node stopped before finishing it: the working tree may hold its partial changes. Check git status and git log first, then finish the node."]
      : []),
    "",
    claim.packet,
    "",
    "### Runtime Turn Rules (Hard Constraints)",
    "- Execute only the claimed node in this turn.",
    "- Do not explore the repository beyond what the claimed node needs.",
    "- After completing or decomposing the claimed node, end this turn immediately.",
    ...(ATP_CONFIG.commitPerNode
      ? [
          "- When the node is completed successfully with file changes, create exactly one git commit before running atp-complete-task.",
          `- Commit message format: node(${claim.node}): <short title>.`,
          "- If no files changed for a successfully completed node, say so in the report instead of committing.",
          "- If a commit is blocked, do not fail the node for that alone: report the blocker; the runner commits what is left.",
        ]
      : []),
    "- Use web search whenever the node depends on fast-changing external docs, APIs or SDKs, and cite the sources in the report.",
    "- Before completing with --status DONE, run the lint and typecheck that fit the files and systems you touched. If they fail, fix and rerun; mark FAILED only for problems you cannot fix within the node, with the concrete errors.",
    "- Structure the report with these sections: Outcome, Facts Learned, Decisions Made, Files Touched, Interfaces Changed, Verification, Risks, Recommended Next Step. Write 'None' for an empty section; later nodes and replanning read these handoffs.",
    "- Never leave the node CLAIMED: complete it (DONE or FAILED) or decompose it before you end the turn.",
  ].join("\n");
}

/** Sent once when a worker's run ended with its node still claimed. */
export const nudgeMessage = (node: string): string =>
  `Your run ended but ATP node ${node} is still CLAIMED. Finish it now: complete it with atp-complete-task (--status DONE with the report, or --status FAILED with the concrete blocker), or decompose it with atp-decompose-task. Do not end this turn with the node claimed.`;
