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

const KEY = "pi-studio:sidebar";

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
