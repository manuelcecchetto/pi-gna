import { describe, expect, it } from "vitest";
import { ATP_CONFIG, type AtpNode, type AtpPlan } from "../shared/atp";
import type { AtpRunner } from "../shared/host-api";
import { defaultPlan, groupNodes, startLabel, stalledNode } from "./atp-data";

const node = (id: string, status: AtpNode["status"], extra: Partial<AtpNode> = {}): AtpNode =>
  ({ id, title: id, description: "", dependencies: [], children: [], artifacts: [], status, scope: false, ...extra }) as AtpNode;
const plan = (nodes: AtpNode[], status: AtpPlan["status"] = "ACTIVE"): AtpPlan => ({ path: "/p/a.atp.json", name: "a", status, nodes }) as AtpPlan;
const runner = { plan: "/p/a.atp.json", cwd: "/p", phase: "working", since: 0 } as AtpRunner;

describe("groupNodes", () => {
  it("orders groups by what needs you, keeps plan order inside, drops empty ones", () => {
    const groups = groupNodes(plan([node("a", "COMPLETED"), node("b", "READY"), node("c", "FAILED"), node("d", "CLAIMED"), node("e", "READY")]));
    expect(groups.map((g) => [g.look, g.nodes.map((n) => n.id)])).toEqual([["running", ["d"]], ["failed", ["c"]], ["ready", ["b", "e"]], ["done", ["a"]]]);
  });
  it("shows an interrupted claim apart from running ones", () => {
    expect(groupNodes(plan([node("a", "CLAIMED")]), "a").map((g) => g.look)).toEqual(["stalled"]);
  });
});

describe("stalledNode", () => {
  const held = plan([node("a", "CLAIMED", { worker: ATP_CONFIG.agentId }), node("b", "CLAIMED", { worker: "someone" })]);
  it("is the node pi-gna's worker holds when nothing runs the plan", () => expect(stalledNode(held, undefined)).toBe("a"));
  it("is none while the plan runs, and for other workers' claims", () => {
    expect(stalledNode(held, runner)).toBeUndefined();
    expect(stalledNode(plan([node("b", "CLAIMED", { worker: "someone" })]), undefined)).toBeUndefined();
  });
});

describe("startLabel", () => {
  it("names the run button by the plan's state", () => {
    expect(startLabel(plan([node("a", "READY")], "DRAFT"))).toBe("Start");
    expect(startLabel(plan([node("a", "READY")]))).toBe("Run");
    expect(startLabel(plan([node("a", "CLAIMED")]), "a")).toBe("Resume");
  });
  it("offers nothing for a finished or archived plan", () => {
    expect(startLabel(plan([node("a", "COMPLETED")]))).toBeUndefined();
    expect(startLabel(plan([node("a", "READY")], "ARCHIVED"))).toBeUndefined();
  });
});

describe("defaultPlan", () => {
  const files = [
    { path: "/p/old.atp.json", modifiedAt: 1 },
    { path: "/p/new.atp.json", modifiedAt: 9 },
    { path: "/p/run.atp.json", modifiedAt: 5 },
  ];
  it("prefers the plan that runs, else the newest", () => {
    expect(defaultPlan(files, { "/p/run.atp.json": runner })?.path).toBe("/p/run.atp.json");
    expect(defaultPlan(files, {})?.path).toBe("/p/new.atp.json");
    expect(defaultPlan([], {})).toBeUndefined();
  });
});
