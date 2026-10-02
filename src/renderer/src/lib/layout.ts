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
