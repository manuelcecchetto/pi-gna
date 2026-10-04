import { describe, expect, it } from "vitest";
import { ATP_CONFIG, isPlanPath, parseClaim, parsePlan, planName, planProgress, workerMessage, workingNodes } from "./atp";

const graph = {
  meta: { project_name: "OAuth Login Upgrade", version: "1.3", project_status: "ACTIVE" },
  nodes: {
    T1: { title: "Design", instruction: "Design it", dependencies: [], status: "COMPLETED", report: "Outcome: done" },
    T2: { title: "Build", instruction: "Build it", dependencies: ["T1"], status: "CLAIMED", type: "SCOPE", scope_children: ["T2a", "T2b", "gone"] },
    T2a: { title: "Backend", instruction: "", dependencies: ["T1"], status: "CLAIMED", worker_id: "pigna-w1" },
    T2b: { title: "Frontend", instruction: "", dependencies: ["T2a", "missing", "T2b"], status: "LOCKED" },
    T3: { title: "Old idea", instruction: "", dependencies: ["T2b"], status: "LOCKED", future_state: "SUPERSEDED" },
    T4: { title: "Ship", instruction: "", dependencies: ["T2b"], status: "READY" },
    T5: { title: "Broke", instruction: "", dependencies: [], status: "FAILED" },
    T6: { instruction: "", dependencies: [], status: "WEIRD" },
  },
};

describe("parsePlan", () => {
  const plan = parsePlan("/repo/oauth.atp.json", graph);

  it("reads the meta and the nodes in file order", () => {
    expect(plan.name).toBe("OAuth Login Upgrade");
    expect(plan.status).toBe("ACTIVE");
    expect(plan.nodes.map((node) => node.id)).toEqual(["T1", "T2", "T2a", "T2b", "T3", "T4", "T5", "T6"]);
  });

  it("keeps scopes, their children and closed nodes, and drops links to nodes that are not there", () => {
    const byId = Object.fromEntries(plan.nodes.map((node) => [node.id, node]));
    expect(byId.T2).toMatchObject({ scope: true, children: ["T2a", "T2b"] });
    expect(byId.T2b?.dependencies).toEqual(["T2a"]);
    expect(byId.T3?.closed).toBe("SUPERSEDED");
    expect(byId.T2a?.worker).toBe("pigna-w1");
    expect(byId.T6).toMatchObject({ title: "T6", status: "LOCKED" });
  });

  it("names a plan without a project name after its file, and refuses what is no plan", () => {
    expect(parsePlan("/repo/plans/auth.atp.json", { nodes: {} }).name).toBe("auth");
    expect(parsePlan("/repo/auth.atp.json", { nodes: {} }).status).toBe("DRAFT");
    expect(() => parsePlan("/x.atp.json", { nodes: [] })).toThrow(/not an ATP plan/);
    expect(() => parsePlan("/x.atp.json", null)).toThrow(/not an ATP plan/);
    expect(planName("/a/b/big-one.atp.json")).toBe("big-one");
  });

  it("counts progress without scopes and closed nodes, and finds the nodes workers hold", () => {
    expect(planProgress(plan)).toEqual({ total: 6, completed: 1, failed: 1, claimed: 1, ready: 1, locked: 2 });
    expect(workingNodes(plan).map((node) => node.id)).toEqual(["T2a"]);
  });
});

describe("parseClaim", () => {
  it("reads an assignment, keeping the whole packet", () => {
    const packet = "TASK ASSIGNED: T2a - Backend: the API\nSTATUS: CLAIMED\nINSTRUCTION:\nDo it\nCONTEXT FROM DEPENDENCIES:\n- none";
    expect(parseClaim(`${packet}\n`)).toEqual({ kind: "assigned", node: "T2a", title: "Backend: the API", packet });
  });

  it("tells nothing to do from an inactive project, and fails on anything else", () => {
    expect(parseClaim("NO_TASKS_AVAILABLE: All tasks are blocked, claimed, or the project is finished. Newly READY: T4.").kind).toBe("none");
    expect(parseClaim("Project is not ACTIVE (status=DRAFT). Resume the project before claiming work.").kind).toBe("inactive");
    expect(() => parseClaim("Traceback (most recent call last):")).toThrow(/unexpected answer/);
  });
});

describe("workerMessage", () => {
  it("puts the runtime context and the hard rules around the librarian's packet", () => {
    const claim = { kind: "assigned" as const, node: "T2a", title: "Backend", packet: "TASK ASSIGNED: T2a - Backend\nSTATUS: CLAIMED" };
    const message = workerMessage({ project: "/repo", plan: "/repo/x.atp.json", branch: "main", librarian: "/app/lib.py", claim });
    expect(message).toContain("- plan_path: /repo/x.atp.json");
    expect(message).toContain(`- agent_id: ${ATP_CONFIG.agentId}`);
    expect(message).toContain(claim.packet);
    expect(message).toContain("node(T2a): <short title>");
    expect(message).toContain("python3 '/app/lib.py' atp-read-graph --plan-path '/repo/x.atp.json' --view-mode local --node-id 'T2a'");
    expect(message).toContain("Never leave the node CLAIMED");
  });
});

it("isPlanPath takes absolute .atp.json paths only", () => {
  expect(isPlanPath("/repo/a.atp.json")).toBe(true);
  expect(isPlanPath("repo/a.atp.json")).toBe(false);
  expect(isPlanPath("/repo/a.json")).toBe(false);
  expect(isPlanPath(undefined)).toBe(false);
});
