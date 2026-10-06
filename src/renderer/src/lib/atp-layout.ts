// Layered layout of an ATP plan for the ATP page's graph, left to right like the plan runs: a small Sugiyama
// pipeline (longest-path layers, dummy nodes on long edges, barycenter ordering, then y positions that straighten
// edges without overlaps). Pure and fast enough to rerun on every plan change (a few ms for 300 nodes).
import type { AtpNode } from "../../../shared/atp";

export const NODE_W = 224;
export const NODE_H = 64;
const GAP_X = 72;
const GAP_Y = 18;
/** Room between edges that pass through a layer (dummies), and between them and nodes. */
const DUMMY_H = 10;
const ORDER_SWEEPS = 12;
const PLACE_SWEEPS = 8;

export interface LaidNode {
  id: string;
  x: number;
  y: number;
  layer: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  /** A decomposed node to one of its children: the librarian keeps no dependency there, so it is drawn dotted. */
  scope: boolean;
  /** SVG path data, from the right side of `from` to the left side of `to`. */
  path: string;
}

export interface PlanLayout {
  nodes: Map<string, LaidNode>;
  edges: LaidEdge[];
  width: number;
  height: number;
}

type Item = { id: string; dummy: boolean; layer: number; order: number; y: number; h: number; up: Item[]; down: Item[] };

export function layoutPlan(nodes: Pick<AtpNode, "id" | "dependencies" | "scope" | "children">[]): PlanLayout {
  const ids = new Set(nodes.map((node) => node.id));
  // Every edge as from -> to: dependencies, and a scope to its children (whose start nodes share the scope's own
  // dependencies, so without these edges a scope would float beside its children).
  const edges: { from: string; to: string; scope: boolean }[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, scope: boolean) => {
    const key = `${from}\n${to}`;
    if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, scope });
  };
  for (const node of nodes) for (const dep of node.dependencies) addEdge(dep, node.id, false);
  for (const node of nodes) if (node.scope) for (const child of node.children) addEdge(node.id, child, true);

  const acyclic = dropBackEdges(nodes.map((node) => node.id), edges);
  const layer = assignLayers(nodes.map((node) => node.id), acyclic);

  // Items: real nodes, plus a dummy per layer an edge passes through.
  const items = new Map<string, Item>();
  const item = (id: string, dummy: boolean, at: number): Item => {
    const created: Item = { id, dummy, layer: at, order: 0, y: 0, h: dummy ? DUMMY_H : NODE_H, up: [], down: [] };
    items.set(id, created);
    return created;
  };
  for (const node of nodes) item(node.id, false, layer.get(node.id) ?? 0);
  const chains: { from: string; to: string; scope: boolean; via: Item[] }[] = [];
  for (const edge of acyclic) {
    const from = items.get(edge.from) as Item;
    const to = items.get(edge.to) as Item;
    const via: Item[] = [];
    let previous = from;
    for (let at = from.layer + 1; at < to.layer; at++) {
      const dummy = item(`${edge.from}\n${edge.to}\n${at}`, true, at);
      link(previous, dummy);
      via.push(dummy);
      previous = dummy;
    }
    link(previous, to);
    chains.push({ ...edge, via });
  }

  const layers = orderLayers(nodes.map((node) => node.id), items);
  placeY(layers);

  const laid = new Map<string, LaidNode>();
  let width = 0;
  let height = 0;
  let top = Number.POSITIVE_INFINITY;
  for (const entry of items.values()) top = Math.min(top, entry.y - entry.h / 2);
  if (!Number.isFinite(top)) top = 0;
  for (const node of nodes) {
    const entry = items.get(node.id) as Item;
    const x = entry.layer * (NODE_W + GAP_X);
    const y = entry.y - NODE_H / 2 - top;
    laid.set(node.id, { id: node.id, x, y, layer: entry.layer });
    width = Math.max(width, x + NODE_W);
    height = Math.max(height, y + NODE_H);
  }

  const laidEdges = chains.map(({ from, to, scope, via }) => {
    const a = items.get(from) as Item;
    const b = items.get(to) as Item;
    const points: [number, number][] = [[a.layer * (NODE_W + GAP_X) + NODE_W, a.y - top]];
    for (const dummy of via) {
      // A dummy spans the node column, so the edge runs straight through it.
      const left = dummy.layer * (NODE_W + GAP_X);
      points.push([left, dummy.y - top], [left + NODE_W, dummy.y - top]);
    }
    points.push([b.layer * (NODE_W + GAP_X), b.y - top]);
    return { from, to, scope, path: curve(points) };
  });
  // Back edges (a cycle, which a valid plan never has) are drawn too, so nothing is hidden.
  const kept = new Set(acyclic);
  for (const edge of edges) {
    if (kept.has(edge)) continue;
    const a = laid.get(edge.from) as LaidNode;
    const b = laid.get(edge.to) as LaidNode;
    laidEdges.push({ ...edge, path: curve([[a.x + NODE_W, a.y + NODE_H / 2], [b.x, b.y + NODE_H / 2]]) });
  }
  return { nodes: laid, edges: laidEdges, width, height };
}

function link(a: Item, b: Item): void {
  a.down.push(b);
  b.up.push(a);
}

/** Edges without those that close a cycle (found depth-first in file order). */
function dropBackEdges<E extends { from: string; to: string }>(ids: string[], edges: E[]): E[] {
  const out = new Map<string, E[]>();
  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  const state = new Map<string, 1 | 2>();
  const back = new Set<E>();
  for (const root of ids) {
    if (state.has(root)) continue;
    // Iterative DFS: plans can be deep chains.
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const edge = out.get(frame.id)?.[frame.next++];
      if (!edge) {
        state.set(frame.id, 2);
        stack.pop();
      } else if (state.get(edge.to) === 1) back.add(edge);
      else if (!state.has(edge.to)) {
        state.set(edge.to, 1);
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return back.size ? edges.filter((edge) => !back.has(edge)) : edges;
}

/**
 * Longest path from the sources, then every node that feeds others moves right next to its earliest consumer, so a
 * node with no dependencies sits beside what needs it rather than at the far left with a long edge.
 */
function assignLayers(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const ups = new Map<string, string[]>(ids.map((id) => [id, []]));
  const downs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { from, to } of edges) {
    downs.get(from)?.push(to);
    ups.get(to)?.push(from);
  }
  // Kahn's topological order.
  const pending = new Map(ids.map((id) => [id, ups.get(id)?.length ?? 0]));
  const order = ids.filter((id) => pending.get(id) === 0);
  for (let i = 0; i < order.length; i++) {
    for (const next of downs.get(order[i] as string) ?? []) {
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) order.push(next);
    }
  }
  const layer = new Map<string, number>();
  for (const id of order) layer.set(id, Math.max(-1, ...(ups.get(id) ?? []).map((up) => layer.get(up) ?? 0)) + 1);
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i] as string;
    const below = downs.get(id) ?? [];
    if (below.length) layer.set(id, Math.max(layer.get(id) ?? 0, Math.min(...below.map((down) => layer.get(down) ?? 0)) - 1));
  }
  return layer;
}

/** Items per layer, ordered to cross few edges: depth-first first, then alternating barycenter sweeps. */
function orderLayers(ids: string[], items: Map<string, Item>): Item[][] {
  const layers: Item[][] = [];
  const visited = new Set<Item>();
  const visit = (root: Item) => {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop() as Item;
      if (visited.has(current)) continue;
      visited.add(current);
      (layers[current.layer] ??= []).push(current);
      for (let i = current.down.length - 1; i >= 0; i--) stack.push(current.down[i] as Item);
    }
  };
  for (const id of ids) {
    const entry = items.get(id) as Item;
    if (!entry.up.length) visit(entry);
  }
  for (const entry of items.values()) visit(entry);
  for (let at = 0; at < layers.length; at++) layers[at] ??= [];
  const number = (layer: Item[]) => layer.forEach((entry, index) => (entry.order = index));
  layers.forEach(number);

  const crossings = () => countCrossings(layers);
  let best = layers.map((layer) => [...layer]);
  let fewest = crossings();
  for (let sweep = 0; sweep < ORDER_SWEEPS && fewest > 0; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.map((_, at) => at).slice(1) : layers.map((_, at) => at).slice(0, -1).reverse();
    for (const at of range) {
      const layer = layers[at] as Item[];
      const center = (entry: Item) => {
        const near = down ? entry.up : entry.down;
        return near.length ? near.reduce((sum, other) => sum + other.order, 0) / near.length : entry.order;
      };
      const keyed = layer.map((entry) => ({ entry, key: center(entry) }));
      keyed.sort((a, b) => a.key - b.key || a.entry.order - b.entry.order);
      layers[at] = keyed.map(({ entry }) => entry);
      number(layers[at] as Item[]);
    }
    const count = crossings();
    if (count < fewest) {
      fewest = count;
      best = layers.map((layer) => [...layer]);
    }
  }
  best.forEach(number);
  return best;
}

/** Edge crossings between neighbouring layers (pairs whose ends are in opposite order). */
function countCrossings(layers: Item[][]): number {
  let total = 0;
  for (const layer of layers) {
    const ends: [number, number][] = [];
    for (const entry of layer) for (const next of entry.down) ends.push([entry.order, next.order]);
    ends.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Inversions of the lower ends, by insertion into a sorted list: plans have few edges per layer.
    const sorted: number[] = [];
    for (const [, end] of ends) {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((sorted[mid] as number) <= end) lo = mid + 1;
        else hi = mid;
      }
      total += sorted.length - lo;
      sorted.splice(lo, 0, end);
    }
  }
  return total;
}

/**
 * y positions: stacked in each layer's order, then pulled toward the mean of their neighbours, alternately from the
 * left and the right, keeping the order and the gaps (least squares under the gaps: pool adjacent violators).
 */
function placeY(layers: Item[][]): void {
  for (const layer of layers) {
    let y = 0;
    for (const entry of layer) {
      entry.y = y + entry.h / 2;
      y += entry.h + GAP_Y;
    }
  }
  // Centre the layers on each other before straightening.
  const tallest = Math.max(0, ...layers.map(span));
  for (const layer of layers) for (const entry of layer) entry.y += (tallest - span(layer)) / 2;

  for (let sweep = 0; sweep < PLACE_SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers : [...layers].reverse();
    for (const layer of order) {
      const wanted = layer.map((entry) => {
        const near = sweep >= PLACE_SWEEPS - 2 ? [...entry.up, ...entry.down] : down ? entry.up : entry.down;
        return near.length ? near.reduce((sum, other) => sum + other.y, 0) / near.length : entry.y;
      });
      fit(layer, wanted);
    }
  }
}

const span = (layer: Item[]) => layer.reduce((sum, entry) => sum + entry.h + GAP_Y, 0) - GAP_Y;

/** The y closest to `wanted` (least squares) that keeps the layer's order and gaps. */
function fit(layer: Item[], wanted: number[]): void {
  // With offsets o_i (the stack's minimum distance from the first item), z_i = y_i - o_i must not decrease.
  const offsets: number[] = [];
  let offset = 0;
  layer.forEach((entry, index) => {
    if (index > 0) offset += ((layer[index - 1] as Item).h + entry.h) / 2 + GAP_Y;
    offsets.push(offset);
  });
  const blocks: { sum: number; count: number }[] = [];
  wanted.forEach((value, index) => {
    blocks.push({ sum: value - (offsets[index] as number), count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1] as { sum: number; count: number };
      const before = blocks[blocks.length - 2] as { sum: number; count: number };
      if (before.sum / before.count <= last.sum / last.count) break;
      before.sum += last.sum;
      before.count += last.count;
      blocks.pop();
    }
  });
  let index = 0;
  for (const block of blocks) {
    const z = block.sum / block.count;
    for (let i = 0; i < block.count; i++, index++) (layer[index] as Item).y = z + (offsets[index] as number);
  }
}

/** A smooth path through the points: horizontal tangents at every point, like a flowchart's connectors. */
function curve(points: [number, number][]): string {
  const [first, ...rest] = points as [[number, number], ...[number, number][]];
  let path = `M${round(first[0])} ${round(first[1])}`;
  let [px, py] = first;
  for (const [x, y] of rest) {
    if (Math.abs(y - py) < 0.5) path += `L${round(x)} ${round(y)}`;
    else {
      const dx = Math.max(24, (x - px) / 2);
      path += `C${round(px + dx)} ${round(py)} ${round(x - dx)} ${round(y)} ${round(x)} ${round(y)}`;
    }
    px = x;
    py = y;
  }
  return path;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Where a plan too big to read when fitted opens: where its work is now. The first running node, else one a stopped
 * run left behind, a failed one, the first ready one; a finished plan opens on its outcome and an untouched one on its
 * start. Ties go to the leftmost (earliest) node.
 */
export function startNode(nodes: Pick<AtpNode, "id" | "status" | "scope" | "closed">[], layout: PlanLayout, stalled?: string): string | undefined {
  const at = (id: string) => layout.nodes.get(id) ?? { x: 0, y: 0 };
  const work = nodes
    .filter((node) => !node.scope && !node.closed && layout.nodes.has(node.id))
    .sort((a, b) => at(a.id).x - at(b.id).x || at(a.id).y - at(b.id).y);
  const find = (test: (node: (typeof work)[number]) => boolean) => work.find(test)?.id;
  return (
    find((node) => node.status === "CLAIMED" && node.id !== stalled) ??
    find((node) => node.id === stalled) ??
    find((node) => node.status === "FAILED") ??
    find((node) => node.status === "READY") ??
    (work.length && work.every((node) => node.status === "COMPLETED") ? work.at(-1)?.id : work[0]?.id) ??
    nodes[0]?.id
  );
}

/** A node and everything it depends on or that depends on it, through dependencies and scopes: the selection's lineage. */
export function lineage(nodes: Pick<AtpNode, "id" | "dependencies" | "scope" | "children">[], id: string): Set<string> {
  const ups = new Map<string, string[]>();
  const downs = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    downs.set(from, [...(downs.get(from) ?? []), to]);
    ups.set(to, [...(ups.get(to) ?? []), from]);
  };
  for (const node of nodes) {
    for (const dep of node.dependencies) add(dep, node.id);
    if (node.scope) for (const child of node.children) add(node.id, child);
  }
  const found = new Set([id]);
  for (const links of [ups, downs]) {
    const queue = [id];
    while (queue.length) {
      for (const next of links.get(queue.pop() as string) ?? []) {
        if (found.has(next)) continue;
        found.add(next);
        queue.push(next);
      }
    }
  }
  return found;
}
