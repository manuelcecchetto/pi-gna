// Sidebar sizing (Codex-style: resizable, collapsible, remembered across restarts).

export const SIDEBAR_DEFAULT = 268;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
/** The chat area never gets narrower than this because of the sidebar. */
const MAIN_MIN = 520;

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
}

export function clampSidebarWidth(width: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - MAIN_MIN));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, Number.isFinite(width) ? width : SIDEBAR_DEFAULT)));
}

/** Dragging the edge left of this collapses the sidebar (about half the minimum width). */
export const SIDEBAR_COLLAPSE_AT = 120;

/** Where a resize drag at pointer x puts the sidebar: a width, or collapsed when pulled to the window edge. */
export function sidebarDrag(pointerX: number, windowWidth: number): { collapsed: true } | { collapsed: false; width: number } {
  if (pointerX < SIDEBAR_COLLAPSE_AT) return { collapsed: true };
  return { collapsed: false, width: clampSidebarWidth(pointerX, windowWidth) };
}

const KEY = "pigna:sidebar";

export function loadSidebar(): SidebarLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SidebarLayout> | null;
    return { width: typeof saved?.width === "number" ? saved.width : SIDEBAR_DEFAULT, collapsed: saved?.collapsed === true };
  } catch {
    return { width: SIDEBAR_DEFAULT, collapsed: false };
  }
}

export function saveSidebar(layout: SidebarLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // storage unavailable: the layout just is not remembered
  }
}

// ATP page panels: the node panel and the orchestrator's conversation are resized by dragging their edge, giving room
// to (or taking it from) the graph, and remembered across restarts.

export interface PanelBounds {
  min: number;
  max: number;
  fallback: number;
}

export const ATP_DETAIL: PanelBounds = { min: 300, max: 900, fallback: 380 };
export const ATP_DOCK: PanelBounds = { min: 120, max: 1200, fallback: 300 };
/** A panel never squeezes the graph (or what stands in its place) below this. */
export const ATP_GRAPH_MIN = { width: 280, height: 160 };

/** A panel size between its bounds, and at most `room` (what it may take before the graph hits its minimum). */
export function clampPanel(size: number, bounds: PanelBounds, room = Number.POSITIVE_INFINITY): number {
  const max = Math.max(bounds.min, Math.min(bounds.max, room));
  return Math.round(Math.min(max, Math.max(bounds.min, Number.isFinite(size) ? size : bounds.fallback)));
}

export interface AtpPanels {
  detail: number;
  dock: number;
}

const ATP_KEY = "pigna:atp-panels";

export function loadAtpPanels(): AtpPanels {
  const fallback = { detail: ATP_DETAIL.fallback, dock: ATP_DOCK.fallback };
  try {
    const saved = JSON.parse(localStorage.getItem(ATP_KEY) ?? "null") as Partial<AtpPanels> | null;
    const pick = (key: keyof AtpPanels) => (typeof saved?.[key] === "number" ? (saved[key] as number) : fallback[key]);
    return { detail: pick("detail"), dock: pick("dock") };
  } catch {
    return fallback;
  }
}

export function saveAtpPanels(panels: AtpPanels): void {
  try {
    localStorage.setItem(ATP_KEY, JSON.stringify(panels));
  } catch {
    // storage unavailable: the sizes just are not remembered
  }
}
