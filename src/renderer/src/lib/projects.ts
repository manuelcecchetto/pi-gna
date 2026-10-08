// Sidebar projects: pinned folders first (in the order you pinned them), then the rest by latest activity.
// Opening or switching chats never reorders anything; only pinning and sending a message do. Hidden projects come
// last, flagged, for the lists to leave out. Pins and hidden projects are app-only state kept by the host (lib/host-ui.ts).
import { projectOf } from "../../../shared/board";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { isTriage } from "../../../shared/task-prompts";
import type { Attention } from "../../../shared/session-state";
import { applyUi, uiStore } from "./host-ui";
import { useStore } from "./store";

/**
 * What the chat lists show of an open chat (state/app.ts openChat). Streaming changes none of it, so lists that select
 * these instead of the sessions do not render on every frame.
 */
export interface OpenChat {
  handle: string;
  cwd: string;
  sessionPath?: string;
  title: string;
  attention: Attention;
  /** When you last sent a message from pi-gna; undefined for chats only opened from disk. */
  sentAt?: number;
  /** Shown in the chat lists (shared/session-state.ts isListed). */
  listed: boolean;
  draft: boolean;
  exited: boolean;
}

export interface ProjectRow {
  key: string;
  time?: number;
  summary?: SessionSummary;
  live?: OpenChat;
}

export interface ProjectView {
  cwd: string;
  pinned: boolean;
  hidden: boolean;
  rows: ProjectRow[];
}

/**
 * Indexed projects plus open chats (matched by session file, grouped by projectOf), ordered for the sidebar; card
 * triage chats and ATP chats (reached from the ATP page) are left out.
 */
export function projectViews(projects: ProjectGroup[], open: OpenChat[], pinned: string[], hidden: string[] = []): ProjectView[] {
  const groups = new Map<string, { cwd: string; activeAt: number; rows: ProjectRow[] }>();
  for (const project of projects) {
    const sessions = project.sessions.filter((summary) => !(summary.named && isTriage(summary.title)));
    if (!sessions.length) continue;
    const rows = sessions.map((summary) => ({ key: summary.path, time: summary.modifiedAt, summary }));
    groups.set(project.cwd, { cwd: project.cwd, activeAt: Math.max(...sessions.map((summary) => summary.modifiedAt)), rows });
  }
  for (const session of open) {
    if (!session.listed) continue;
    const cwd = projectOf(session.cwd);
    const group = groups.get(cwd) ?? { cwd, activeAt: 0, rows: [] };
    const sent = session.sentAt;
    const row = group.rows.find((r) => r.summary && r.summary.path === session.sessionPath);
    if (row) {
      row.live = session;
      if (sent) row.time = Math.max(row.time ?? 0, sent);
    } else group.rows.push({ key: session.handle, time: sent, live: session });
    if (sent) group.activeAt = Math.max(group.activeAt, sent);
    groups.set(cwd, group);
  }
  // Pins by place, then the rest, then the hidden.
  const rank = (cwd: string) => {
    if (hidden.includes(cwd)) return pinned.length + 1;
    const index = pinned.indexOf(cwd);
    return index < 0 ? pinned.length : index;
  };
  return [...groups.values()]
    .sort((a, b) => (rank(a.cwd) === rank(b.cwd) ? b.activeAt - a.activeAt : rank(a.cwd) - rank(b.cwd)))
    .map(({ cwd, rows }) => ({
      cwd,
      pinned: pinned.includes(cwd),
      hidden: hidden.includes(cwd),
      // Chats not in the index yet (just started) have no time and stay on top until it catches up.
      rows: rows.sort((a, b) => (b.time ?? Number.POSITIVE_INFINITY) - (a.time ?? Number.POSITIVE_INFINITY)),
    }));
}

// ── Pins ─────────────────────────────────────────────────────────────────────

export function usePinnedProjects(): string[] {
  return useStore(uiStore, (state) => state.pins);
}

/** New pins go below the existing ones, so pinned projects keep their places. */
export function togglePinnedProject(cwd: string): void {
  applyUi({ type: uiStore.get().pins.includes(cwd) ? "unpin" : "pin", cwd });
}

// ── Hidden ───────────────────────────────────────────────────────────────────

export function useHiddenProjects(): string[] {
  return useStore(uiStore, (state) => state.hidden);
}

/** Hiding unpins too. A new chat in a hidden project brings it back (state/app.ts newSession). */
export function setProjectHidden(cwd: string, hidden: boolean): void {
  applyUi({ type: hidden ? "hide" : "unhide", cwd });
}
