// Sidebar projects: pinned folders first (in the order you pinned them), then the rest by latest activity.
// Opening or switching chats never reorders anything; only pinning and sending a message do. Pins are
// app-only state kept by the host (lib/host-ui.ts).
import { projectOf } from "../../../shared/board";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { isTriage } from "../../../shared/task-prompts";
import { isListed, type SessionState } from "../../../shared/session-state";
import { applyUi, uiStore } from "./host-ui";
import { useStore } from "./store";

export interface ProjectRow {
  key: string;
  time?: number;
  summary?: SessionSummary;
  live?: SessionState;
}

export interface ProjectView {
  cwd: string;
  pinned: boolean;
  rows: ProjectRow[];
}

/**
 * Indexed projects plus open chats (matched by session file, grouped by projectOf), ordered for the sidebar; card
 * triage chats and ATP chats (reached from the ATP page) are left out.
 */
export function projectViews(projects: ProjectGroup[], open: SessionState[], pinned: string[]): ProjectView[] {
  const groups = new Map<string, { cwd: string; activeAt: number; rows: ProjectRow[] }>();
  for (const project of projects) {
    const sessions = project.sessions.filter((summary) => !(summary.named && isTriage(summary.title)));
    if (!sessions.length) continue;
    const rows = sessions.map((summary) => ({ key: summary.path, time: summary.modifiedAt, summary }));
    groups.set(project.cwd, { cwd: project.cwd, activeAt: Math.max(...sessions.map((summary) => summary.modifiedAt)), rows });
  }
  for (const session of open) {
    if (!isListed(session)) continue;
    const cwd = projectOf(session.cwd);
    const group = groups.get(cwd) ?? { cwd, activeAt: 0, rows: [] };
    const sent = sentAt(session);
    const row = group.rows.find((r) => r.summary && r.summary.path === session.sessionPath);
    if (row) {
      row.live = session;
      if (sent) row.time = Math.max(row.time ?? 0, sent);
    } else group.rows.push({ key: session.handle, time: sent, live: session });
    if (sent) group.activeAt = Math.max(group.activeAt, sent);
    groups.set(cwd, group);
  }
  const rank = (cwd: string) => {
    const index = pinned.indexOf(cwd);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return [...groups.values()]
    .sort((a, b) => (rank(a.cwd) === rank(b.cwd) ? b.activeAt - a.activeAt : rank(a.cwd) - rank(b.cwd)))
    .map(({ cwd, rows }) => ({
      cwd,
      pinned: pinned.includes(cwd),
      // Chats not in the index yet (just started) have no time and stay on top until it catches up.
      rows: rows.sort((a, b) => (b.time ?? Number.POSITIVE_INFINITY) - (a.time ?? Number.POSITIVE_INFINITY)),
    }));
}

/**
 * When you last sent a message from pi-gna, so the chat and its project move up right away instead of when the
 * index refreshes after the run. Chats only opened from disk count as untouched: their file time already says it.
 */
function sentAt(session: SessionState): number | undefined {
  if (!session.prompted) return undefined;
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i];
    if (item?.kind === "user") return item.message.timestamp;
  }
  return undefined;
}

// ── Pins ─────────────────────────────────────────────────────────────────────

export function usePinnedProjects(): string[] {
  return useStore(uiStore, (state) => state.pins);
}

/** New pins go below the existing ones, so pinned projects keep their places. */
export function togglePinnedProject(cwd: string): void {
  applyUi({ type: uiStore.get().pins.includes(cwd) ? "unpin" : "pin", cwd });
}
