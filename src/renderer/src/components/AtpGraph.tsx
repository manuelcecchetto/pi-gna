// The ATP page's graph: a plan's nodes laid out left to right (lib/atp-layout.ts) as HTML cards over an SVG of
// edges, in one layer that pans and zooms with a CSS transform. Drawn natively for plans of hundreds of nodes: the
// layout only reruns when the graph's shape changes, pan and zoom never re-render React, and zoomed out the cards
// lose their text and become status-colored blocks (data-lod), so a whole plan reads as a map of its progress.
// Running nodes glow and the edges into them march; a minimap shows where you are in a plan that does not fit.
import { Ban, CircleCheck, CircleDashed, CircleX, Layers, LoaderCircle, Lock, Maximize, Minus, Plus, TriangleAlert } from "lucide-react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AtpNode, AtpPlan } from "../../../shared/atp";
import { type LaidEdge, type PlanLayout, layoutPlan, lineage, NODE_H, NODE_W } from "../lib/atp-layout";
import { Elapsed } from "./primitives";

export interface GraphHandle {
  fit(): void;
  /** Center a node (search, a dependency link) and keep it centered while the view resizes, until you pan. */
  reveal(id: string): void;
}

const MIN_ZOOM = 0.06;
const MAX_ZOOM = 1.6;
const PAD = 48;
/** Zoom below which a card only shows its title, and below which it is a colored block. */
const LOD_MID = 0.6;
const LOD_FAR = 0.34;

type View = { x: number; y: number; k: number };

/** What decides the layout: ids, dependencies and scopes, not statuses (which change all the time). */
const shapeOf = (nodes: AtpNode[]) => nodes.map((node) => `${node.id}<${node.dependencies.join(",")}${node.scope ? `>${node.children.join(",")}` : ""}`).join("|");

/** The card's look: its status, but a node a stopped run left claimed is "stalled", not running. */
export type NodeLook = "done" | "failed" | "running" | "stalled" | "scope" | "ready" | "locked" | "closed";
export const lookOf = (node: Pick<AtpNode, "status" | "scope" | "closed">, stalled = false): NodeLook =>
  node.closed
    ? "closed"
    : node.scope && node.status === "CLAIMED"
      ? "scope"
      : node.status === "COMPLETED"
        ? "done"
        : node.status === "FAILED"
          ? "failed"
          : node.status === "CLAIMED"
            ? stalled
              ? "stalled"
              : "running"
            : node.status === "READY"
              ? "ready"
              : "locked";

export const LOOK_LABEL: Record<NodeLook, string> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  stalled: "Interrupted",
  scope: "Split",
  ready: "Ready",
  locked: "Locked",
  closed: "Closed",
};

export const AtpGraph = forwardRef<
  GraphHandle,
  {
    plan: AtpPlan;
    selected?: string;
    stalled?: string;
    matches: Set<string>;
    onSelect: (id: string | undefined) => void;
    /** The bottom of the view the orchestrator floats over: fitting and centering keep the plan above it. */
    inset?: number;
  }
>(function AtpGraph({ plan, selected, stalled, matches, onSelect, inset = 0 }, ref) {
  const viewport = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  /** The node reveal() centered: it stays centered when the view resizes (the node panel opens) until you pan. */
  const focus = useRef<string>(undefined);
  /** The zoom that fits the whole plan; the minimap only shows while you are zoomed in well past it. */
  const fitK = useRef(1);
  const [zoom, setZoom] = useState(1);
  const [overview, setOverview] = useState(false);
  const covered = useRef(inset);
  covered.current = inset;
  /** The view is as fit() left it: the orchestrator growing or shrinking fits the plan again. */
  const untouched = useRef(false);

  const shape = shapeOf(plan.nodes);
  // The shape string stands in for the nodes: a status change keeps the layout.
  const layout = useMemo(() => layoutPlan(plan.nodes), [shape]);
  const byId = useMemo(() => new Map(plan.nodes.map((node) => [node.id, node])), [plan.nodes]);
  const related = useMemo(() => (selected && byId.has(selected) ? lineage(plan.nodes, selected) : undefined), [plan.nodes, byId, selected]);

  const apply = useCallback(
    (animate = false) => {
      const { x, y, k } = view.current;
      const element = layer.current;
      const outer = viewport.current;
      if (!element || !outer) return;
      element.style.transition = animate ? "transform 260ms cubic-bezier(.2,.7,.2,1)" : "";
      element.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      element.style.setProperty("--k", String(k));
      element.dataset.lod = k < LOD_FAR ? "far" : k < LOD_MID ? "mid" : "near";
      // The minimap's frame: the part of the plan in view.
      const box = frame.current;
      const scale = minimapScale(layout);
      if (box) {
        const { width, height } = outer.getBoundingClientRect();
        box.style.transition = animate ? "transform 260ms cubic-bezier(.2,.7,.2,1), width 260ms, height 260ms" : "";
        box.style.transform = `translate(${(-x / k) * scale}px, ${(-y / k) * scale}px)`;
        box.style.width = `${(width / k) * scale}px`;
        box.style.height = `${(height / k) * scale}px`;
      }
      setZoom(k);
      setOverview(fitK.current < LOD_MID && k > fitK.current * 1.4);
    },
    [layout],
  );

  const fitScale = useCallback(
    (width: number, height: number) =>
      Math.min(1, Math.max(MIN_ZOOM, Math.min((width - PAD * 2) / Math.max(1, layout.width), (height - PAD * 2) / Math.max(1, layout.height)))),
    [layout],
  );

  const fit = useCallback(
    (animate = false) => {
      const outer = viewport.current;
      if (!outer) return;
      focus.current = undefined;
      const { width } = outer.getBoundingClientRect();
      const height = outer.getBoundingClientRect().height - covered.current;
      const k = fitScale(width, height);
      fitK.current = k;
      view.current = { k, x: (width - layout.width * k) / 2, y: Math.max(PAD, (height - layout.height * k) / 2) };
      apply(animate);
      untouched.current = true;
    },
    [layout, apply, fitScale],
  );

  const center = useCallback(
    (id: string, animate: boolean) => {
      const outer = viewport.current;
      const laid = layout.nodes.get(id);
      if (!outer || !laid) return;
      const { width, height } = outer.getBoundingClientRect();
      const k = Math.max(view.current.k, 0.8);
      view.current = { k, x: width / 2 - (laid.x + NODE_W / 2) * k, y: (height - covered.current) / 2 - (laid.y + NODE_H / 2) * k };
      untouched.current = false;
      apply(animate);
    },
    [layout, apply],
  );

  const reveal = useCallback(
    (id: string) => {
      focus.current = id;
      center(id, true);
    },
    [center],
  );

  useImperativeHandle(ref, () => ({ fit: () => fit(true), reveal }), [fit, reveal]);

  // Only the orchestrator resizing refits: a plan that grows keeps your view.
  const refit = useRef(fit);
  refit.current = fit;
  useEffect(() => {
    if (untouched.current) refit.current();
  }, [inset]);

  // A new plan (or one opened again) starts fitted; a plan that grows keeps your view.
  const fitted = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (fitted.current === plan.path) return;
    fitted.current = plan.path;
    fit();
  }, [plan.path, fit]);

  // The view resizes (the node panel or the orchestrator's conversation opens, the window): what was in the middle
  // stays there, a revealed node stays centered, and the selected one in view.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const outer = viewport.current;
    if (!outer) return;
    let size = outer.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const { width, height } = outer.getBoundingClientRect();
      const v = { ...view.current, x: view.current.x + (width - size.width) / 2, y: view.current.y + (height - size.height) / 2 };
      size = outer.getBoundingClientRect();
      fitK.current = fitScale(width, height - covered.current);
      if (focus.current) return center(focus.current, false);
      const laid = selectedRef.current ? layout.nodes.get(selectedRef.current) : undefined;
      if (laid) {
        const into = (start: number, length: number, room: number) => (start + length > room - 16 ? room - 16 - start - length : start < 16 ? 16 - start : 0);
        v.x += into(v.x + laid.x * v.k, NODE_W * v.k, width);
        v.y += into(v.y + laid.y * v.k, NODE_H * v.k, height - covered.current);
      }
      view.current = v;
      apply();
    });
    observer.observe(outer);
    return () => observer.disconnect();
  }, [layout, apply, center, fitScale]);

  // Wheel: scroll pans, pinch (or ⌘/Ctrl + wheel) zooms around the pointer. Non-passive, to keep the page still.
  useEffect(() => {
    const outer = viewport.current;
    if (!outer) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      focus.current = undefined;
      untouched.current = false;
      const v = view.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = outer.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.01))));
        view.current = { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
      } else view.current = { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY };
      apply();
    };
    outer.addEventListener("wheel", onWheel, { passive: false });
    return () => outer.removeEventListener("wheel", onWheel);
  }, [apply]);

  // Drag anywhere pans, two fingers pinch (touch), and a press that does not move is a click (a node selects it, the
  // background clears it). Pointer events cover the mouse, a pen and touch; the viewport has `touch-action: none`.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Takes the running gesture's start again from where the fingers are now (a finger joined or left). */
  const rebaseGesture = useRef<() => void>(undefined);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, [data-minimap]")) return;
    const outer = viewport.current;
    if (!outer) return;
    const active = pointers.current;
    const target = event.target as HTMLElement;
    const first = active.size === 0;
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // The gesture's start: the view and the fingers' positions, taken again whenever a finger joins or leaves.
    let from = { view: view.current, points: [...active.values()] };
    let moved = false;
    const rebase = () => {
      from = { view: view.current, points: [...active.values()] };
    };
    const move = (e: PointerEvent) => {
      if (!active.has(e.pointerId)) return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = [...active.values()];
      if (now.length !== from.points.length) return rebase();
      const [a0, b0] = from.points;
      const [a, b] = now;
      if (!a0 || !a) return;
      if (!moved && Math.hypot(a.x - a0.x, a.y - a0.y) < 4 && !b) return;
      moved = true;
      focus.current = undefined;
      untouched.current = false;
      if (b0 && b) {
        const rect = outer.getBoundingClientRect();
        const ratio = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, from.view.k * ratio));
        const [mx0, my0] = [(a0.x + b0.x) / 2 - rect.left, (a0.y + b0.y) / 2 - rect.top];
        const [mx, my] = [(a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top];
        view.current = { k, x: mx - ((mx0 - from.view.x) * k) / from.view.k, y: my - ((my0 - from.view.y) * k) / from.view.k };
      } else view.current = { ...from.view, x: from.view.x + a.x - a0.x, y: from.view.y + a.y - a0.y };
      apply();
    };
    const up = (e: PointerEvent) => {
      if (!active.delete(e.pointerId)) return;
      if (active.size > 0) return rebase();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (moved || e.type === "pointercancel" || !first) return;
      const node = target.closest<HTMLElement>("[data-node]")?.dataset.node;
      onSelect(node === selected ? undefined : node);
    };
    // The first finger's handlers run the whole gesture; a finger that joins only has it start again from here.
    if (!first) return rebaseGesture.current?.();
    rebaseGesture.current = rebase;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const zoomBy = (factor: number) => {
    const outer = viewport.current;
    if (!outer) return;
    const { width } = outer.getBoundingClientRect();
    const middle = (outer.getBoundingClientRect().height - covered.current) / 2;
    const v = view.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
    view.current = { k, x: width / 2 - ((width / 2 - v.x) * k) / v.k, y: middle - ((middle - v.y) * k) / v.k };
    untouched.current = false;
    apply(true);
  };

  /** Minimap press and drag: center the view on that point of the plan. */
  const panTo = (px: number, py: number, animate: boolean) => {
    const outer = viewport.current;
    if (!outer) return;
    focus.current = undefined;
    untouched.current = false;
    const { width, height } = outer.getBoundingClientRect();
    const v = view.current;
    view.current = { ...v, x: width / 2 - px * v.k, y: (height - covered.current) / 2 - py * v.k };
    apply(animate);
  };

  const edges = useMemo(() => {
    const kind = (edge: LaidEdge) => {
      const to = byId.get(edge.to);
      const from = byId.get(edge.from);
      return {
        live: to?.status === "CLAIMED" && !to.scope && edge.to !== stalled,
        done: from?.status === "COMPLETED" && to?.status === "COMPLETED",
        lit: related !== undefined && related.has(edge.from) && related.has(edge.to),
        dim: related !== undefined && !(related.has(edge.from) && related.has(edge.to)),
      };
    };
    // Lit and live edges last, so they are drawn over the others.
    return layout.edges.map((edge) => ({ edge, ...kind(edge) })).sort((a, b) => Number(a.live || a.lit) - Number(b.live || b.lit));
  }, [layout, byId, related, stalled]);

  return (
    <div ref={viewport} onPointerDown={onPointerDown} style={{ touchAction: "none" }} className="relative h-full min-h-0 cursor-grab overflow-hidden select-none active:cursor-grabbing">
      <div ref={layer} className="atp-layer absolute top-0 left-0 origin-top-left" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
          {edges.map(({ edge, live, done, lit, dim }) => (
            <path
              key={`${edge.from}>${edge.to}`}
              d={edge.path}
              className="atp-edge"
              data-live={live || undefined}
              data-done={done || undefined}
              data-scope={edge.scope || undefined}
              data-lit={lit || undefined}
              data-dim={dim || undefined}
            />
          ))}
        </svg>
        {plan.nodes.map((node) => {
          const laid = layout.nodes.get(node.id);
          if (!laid) return null;
          return (
            <NodeCard
              key={node.id}
              node={node}
              look={lookOf(node, node.id === stalled)}
              x={laid.x}
              y={laid.y}
              selected={node.id === selected}
              dim={related !== undefined && !related.has(node.id)}
              match={matches.has(node.id)}
            />
          );
        })}
      </div>
      <div style={{ bottom: inset + 12 }} className="absolute left-3 flex items-center gap-0.5 rounded-lg border border-line bg-panel/90 p-0.5 text-faint shadow-[0_4px_16px_-8px_rgb(0_0_0/0.5)] backdrop-blur">
        <button type="button" title="Zoom out" onClick={() => zoomBy(1 / 1.25)} className="pointer-coarse:p-2.5 rounded-md p-1 hover:bg-raised hover:text-fg">
          <Minus size={13} />
        </button>
        <span className="w-10 text-center font-mono text-[11px]">{Math.round(zoom * 100)}%</span>
        <button type="button" title="Zoom in" onClick={() => zoomBy(1.25)} className="pointer-coarse:p-2.5 rounded-md p-1 hover:bg-raised hover:text-fg">
          <Plus size={13} />
        </button>
        <button type="button" title="Fit the plan" onClick={() => fit(true)} className="pointer-coarse:p-2.5 rounded-md p-1 hover:bg-raised hover:text-fg">
          <Maximize size={13} />
        </button>
      </div>
      {overview && <Minimap plan={plan} layout={layout} stalled={stalled} frame={frame} bottom={inset + 12} onPan={panTo} onReady={apply} />}
    </div>
  );
});

const MINIMAP_W = 184;
const MINIMAP_H = 112;
const minimapScale = (layout: PlanLayout) => Math.min(MINIMAP_W / Math.max(1, layout.width), MINIMAP_H / Math.max(1, layout.height));

/** Colors of the minimap's blocks: the theme's tokens, read when it draws. */
const LOOK_FILL: Record<NodeLook, [token: string, alpha: number]> = {
  done: ["--ok", 0.75],
  failed: ["--bad", 1],
  running: ["--accent", 1],
  stalled: ["--warn", 1],
  scope: ["--accent", 0.45],
  ready: ["--accent", 0.45],
  locked: ["--faint", 0.45],
  closed: ["--faint", 0.15],
};

/** The whole plan small, with a frame on the part in view; press or drag in it to look elsewhere. */
function Minimap({
  plan,
  layout,
  stalled,
  frame,
  bottom,
  onPan,
  onReady,
}: {
  plan: AtpPlan;
  layout: PlanLayout;
  stalled?: string;
  frame: React.RefObject<HTMLDivElement | null>;
  bottom: number;
  onPan: (x: number, y: number, animate: boolean) => void;
  onReady: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = minimapScale(layout);
  const width = Math.max(24, Math.round(layout.width * scale));
  const height = Math.max(16, Math.round(layout.height * scale));
  const [scheme, setScheme] = useState(0);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: light)");
    const change = () => setScheme((value) => value + 1);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useLayoutEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = devicePixelRatio || 1;
    element.width = width * ratio;
    element.height = height * ratio;
    context.scale(ratio, ratio);
    const styles = getComputedStyle(element);
    for (const node of plan.nodes) {
      const laid = layout.nodes.get(node.id);
      if (!laid) continue;
      const [token, alpha] = LOOK_FILL[lookOf(node, node.id === stalled)];
      context.globalAlpha = alpha;
      context.fillStyle = styles.getPropertyValue(token).trim() || "#888";
      context.fillRect(laid.x * scale, laid.y * scale, Math.max(1.5, NODE_W * scale), Math.max(1.5, NODE_H * scale));
    }
    onReady();
  }, [plan.nodes, layout, scale, width, height, stalled, scheme, onReady]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const to = (e: { clientX: number; clientY: number }, animate: boolean) => onPan((e.clientX - box.left) / scale, (e.clientY - box.top) / scale, animate);
    to(event, true);
    const move = (e: PointerEvent) => to(e, false);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      data-minimap
      onPointerDown={onPointerDown}
      title="The whole plan: press or drag to look elsewhere"
      style={{ bottom }}
      className="absolute right-3 cursor-pointer overflow-hidden rounded-lg border border-line-strong bg-panel/90 p-2 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6)] backdrop-blur"
    >
      <div className="relative overflow-hidden" style={{ width, height }}>
        <canvas ref={canvas} style={{ width, height }} className="block" />
        <div ref={frame} className="pointer-events-none absolute top-0 left-0 rounded-[3px] border border-fg/60 bg-fg/[0.06]" />
      </div>
    </div>
  );
}

export function StatusIcon({ node, stalled = false, size = 13 }: { node: Pick<AtpNode, "status" | "scope" | "closed">; stalled?: boolean; size?: number }) {
  switch (lookOf(node, stalled)) {
    case "closed":
      return <Ban size={size} className="shrink-0 text-faint" />;
    case "scope":
      return <Layers size={size} className="shrink-0 text-accent" />;
    case "done":
      return <CircleCheck size={size} className="shrink-0 text-ok" />;
    case "failed":
      return <CircleX size={size} className="shrink-0 text-bad" />;
    case "running":
      return <LoaderCircle size={size} className="spin shrink-0 text-accent" />;
    case "stalled":
      return <TriangleAlert size={size} className="shrink-0 text-warn" />;
    case "ready":
      return <CircleDashed size={size} className="shrink-0 text-accent" />;
    default:
      return <Lock size={size - 1} className="shrink-0 text-faint" />;
  }
}

const NodeCard = memo(function NodeCard({
  node,
  look,
  x,
  y,
  selected,
  dim,
  match,
}: {
  node: AtpNode;
  look: NodeLook;
  x: number;
  y: number;
  selected: boolean;
  dim: boolean;
  match: boolean;
}) {
  const started = look === "running" && node.startedAt ? Date.parse(node.startedAt) : Number.NaN;
  return (
    <div
      data-node={node.id}
      data-look={look}
      data-scope={node.scope || undefined}
      data-selected={selected || undefined}
      data-dim={dim || undefined}
      data-match={match || undefined}
      className="atp-node flex cursor-pointer flex-col justify-center gap-1 pr-3 pl-4"
      style={{ transform: `translate(${x}px, ${y}px)`, width: NODE_W, height: NODE_H }}
      title={`${node.id} · ${LOOK_LABEL[look]}\n${node.title}`}
    >
      <div className="atp-meta flex min-w-0 items-center gap-1.5 text-[10.5px] leading-4">
        <span className="min-w-0 truncate font-mono text-faint">{node.id}</span>
        <span className="atp-state ml-auto flex shrink-0 items-center gap-1">
          {look === "running" && !Number.isNaN(started) ? (
            <span className="font-mono tabular-nums">
              <Elapsed since={started} plain />
            </span>
          ) : node.scope ? (
            `${node.children.length} subtasks`
          ) : (
            LOOK_LABEL[look]
          )}
          <StatusIcon node={node} stalled={look === "stalled"} size={12} />
        </span>
      </div>
      <div className="atp-title line-clamp-2 text-[12.5px] leading-[16px]">{node.title}</div>
    </div>
  );
});
