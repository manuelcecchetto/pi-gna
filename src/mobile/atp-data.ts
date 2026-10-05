// What the phone's ATP page decides from plans and runs: the node list's groups, the interrupted node, the default plan.
import { ATP_CONFIG, type AtpNode, type AtpPlan, type AtpPlanFile } from "../shared/atp";
import type { AtpRunner } from "../shared/host-api";
import { lookOf, type NodeLook } from "../renderer/src/components/AtpGraph";

/** The node list's group order: what needs you first, then what runs, then the rest. */
export const GROUP_ORDER: NodeLook[] = ["running", "stalled", "failed", "ready", "scope", "locked", "done", "closed"];

export interface NodeGroup {
  look: NodeLook;
  nodes: AtpNode[];
}

/** The plan's nodes by look, in GROUP_ORDER; empty groups are left out and nodes keep their plan order. */
export function groupNodes(plan: Pick<AtpPlan, "nodes">, stalled?: string): NodeGroup[] {
  const by = new Map<NodeLook, AtpNode[]>();
  for (const node of plan.nodes) {
    const look = lookOf(node, node.id === stalled);
    by.set(look, [...(by.get(look) ?? []), node]);
  }
  return GROUP_ORDER.flatMap((look) => (by.get(look)?.length ? [{ look, nodes: by.get(look) as AtpNode[] }] : []));
}

/** A node pi-gna's worker holds while nothing runs it: what a run that ended with the app (a crash, a quit) leaves. */
export const stalledNode = (plan: AtpPlan | undefined, runner: AtpRunner | undefined): string | undefined =>
  plan && !runner ? plan.nodes.find((node) => node.status === "CLAIMED" && !node.scope && node.worker === ATP_CONFIG.agentId)?.id : undefined;

/** The plan shown first: the one that runs, else the one changed last. */
export const defaultPlan = (files: AtpPlanFile[], runners: Record<string, AtpRunner>): AtpPlanFile | undefined =>
  files.find((file) => runners[file.path]) ?? [...files].sort((a, b) => b.modifiedAt - a.modifiedAt)[0];

export const PHASES: Record<AtpRunner["phase"], string> = {
  starting: "Starting",
  claiming: "Claiming the next node",
  working: "Working on",
  nudging: "Asking the worker to finish",
  committing: "Committing",
  held: "Waiting for the orchestrator",
  stopping: "Stopping",
};

/** What the run button offers for a plan that is not running; none when there is nothing left to run. */
export function startLabel(plan: AtpPlan, stalled?: string): "Resume" | "Start" | "Run" | undefined {
  const finished = plan.nodes.length > 0 && plan.nodes.every((node) => node.status === "COMPLETED");
  if (finished || plan.status === "ARCHIVED") return undefined;
  return stalled ? "Resume" : plan.status === "DRAFT" ? "Start" : "Run";
}

/** The architects a new plan can start from (the skills the orchestrator ships). */
export const ARCHITECTS = [
  { skill: "atp-architect", label: "Macro plan", about: "Nodes the size of one commit or PR: design, build, test, docs, rollout." },
  { skill: "atp-micro-architect", label: "Micro plan", about: "5-25 minute fresh-context steps, each with exact inputs, outputs and checks." },
] as const;
