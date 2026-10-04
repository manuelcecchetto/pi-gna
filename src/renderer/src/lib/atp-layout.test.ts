import { describe, expect, it } from "vitest";
import { layoutPlan, lineage, NODE_H, NODE_W } from "./atp-layout";

type Node = { id: string; dependencies: string[]; scope: boolean; children: string[] };
const node = (id: string, dependencies: string[] = [], children?: string[]): Node => ({ id, dependencies, scope: Boolean(children), children: children ?? [] });

/** A plan like a big architect's: chains of work with fan-outs and fan-ins, and some decomposed scopes. */
function bigPlan(size: number, seed = 7): Node[] {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const nodes: Node[] = [];
  for (let i = 0; i < size; i++) {
    const deps = new Set<string>();
    const count = i === 0 ? 0 : 1 + Math.floor(random() * 3);
    for (let d = 0; d < count; d++) deps.add(`N${Math.max(0, i - 1 - Math.floor(random() * Math.min(i, 12)))}`);
    nodes.push(node(`N${i}`, [...deps]));
  }
  // Decompose every 25th node: a scope whose children take over its dependencies.
  for (let i = 10; i < size; i += 25) {
    const scope = nodes[i] as Node;
    const kids = [`N${i}a`, `N${i}b`, `N${i}c`];
    scope.scope = true;
    scope.children = kids;
    nodes.push(node(kids[0] as string, scope.dependencies), node(kids[1] as string, [kids[0] as string]), node(kids[2] as string, [kids[0] as string]));
  }
  return nodes;
}

function overlaps(layout: ReturnType<typeof layoutPlan>): number {
  const placed = [...layout.nodes.values()];
  let count = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i] as { x: number; y: number };
      const b = placed[j] as { x: number; y: number };
      if (Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H) count++;
    }
  }
  return count;
}

describe("layoutPlan", () => {
  it("puts every node right of what it depends on, without overlaps", () => {
    const nodes = [node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"]), node("E")];
    const layout = layoutPlan(nodes);
    const at = (id: string) => layout.nodes.get(id) as { x: number; y: number; layer: number };
    expect(at("B").x).toBeGreaterThan(at("A").x);
    expect(at("D").x).toBeGreaterThan(at("C").x);
    expect(at("B").layer).toBe(at("C").layer);
    expect(overlaps(layout)).toBe(0);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual(["A>B", "A>C", "B>D", "C>D"]);
    expect(Math.min(...[...layout.nodes.values()].map((laid) => laid.y))).toBe(0);
  });

  it("moves a source next to the node that needs it instead of leaving a long edge", () => {
    const layout = layoutPlan([node("A"), node("B", ["A"]), node("C", ["B"]), node("late"), node("D", ["C", "late"])]);
    expect(layout.nodes.get("late")?.layer).toBe((layout.nodes.get("D")?.layer ?? 0) - 1);
  });

  it("straightens a chain into one row", () => {
    const layout = layoutPlan([node("A"), node("B", ["A"]), node("C", ["B"]), node("X"), node("Y", ["X"])]);
    expect(new Set(["A", "B", "C"].map((id) => layout.nodes.get(id)?.y)).size).toBe(1);
  });

  it("draws a scope before its children with dotted edges, and routes long edges through the layers between", () => {
    const nodes = [node("A"), node("S", ["A"], ["S1", "S2"]), node("S1", ["A"]), node("S2", ["S1"]), node("Z", ["S2", "A"])];
    const layout = layoutPlan(nodes);
    expect(layout.nodes.get("S1")?.layer).toBe((layout.nodes.get("S")?.layer ?? 0) + 1);
    expect(layout.edges.filter((edge) => edge.scope).map((edge) => edge.to).sort()).toEqual(["S1", "S2"]);
    // A -> Z skips three layers: one bend per layer it passes.
    const long = layout.edges.find((edge) => edge.from === "A" && edge.to === "Z");
    expect(long?.path.match(/[LC]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("survives a cycle, which a valid plan never has", () => {
    const layout = layoutPlan([node("A", ["C"]), node("B", ["A"]), node("C", ["B"])]);
    expect(layout.nodes.size).toBe(3);
    expect(layout.edges).toHaveLength(3);
  });

  it("lays out 300+ nodes quickly, without overlaps", () => {
    const nodes = bigPlan(300);
    layoutPlan(nodes); // warm up the JIT
    const started = performance.now();
    const layout = layoutPlan(nodes);
    const took = performance.now() - started;
    expect(layout.nodes.size).toBe(nodes.length);
    expect(overlaps(layout)).toBe(0);
    for (const n of nodes) for (const dep of n.dependencies) expect((layout.nodes.get(n.id)?.x ?? 0) > (layout.nodes.get(dep)?.x ?? 0)).toBe(true);
    expect(took).toBeLessThan(250);
  });
});

describe("lineage", () => {
  it("is a node with everything upstream and downstream of it, through scopes too", () => {
    const nodes = [node("A"), node("S", ["A"], ["S1"]), node("S1", ["A"]), node("B", ["S1"]), node("X")];
    expect([...lineage(nodes, "S")].sort()).toEqual(["A", "B", "S", "S1"]);
    expect([...lineage(nodes, "X")]).toEqual(["X"]);
  });
});
