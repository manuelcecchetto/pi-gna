// Sidebar projects: pinned folders first (in the order you pinned them), then the rest by latest activity. Within a
// project (and in Recent), pinned chats go first, then the rest; each newest first.
// A chat's time is its last user message (SessionSummary.promptedAt), not the agent's writes: opening or switching
// chats, tool calls and answers never reorder anything; only pinning and sending a message do. Hidden projects come
// last, flagged, for the lists to leave out. Pins and hidden projects are app-only state kept by the host (lib/host-ui.ts).
import { projectOf } from "../../../shared/board";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { isTriage } from "../../../shared/task-prompts";
import type { Attention, SessionState } from "../../../shared/session-state";
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
  /** Its subagents as the chat's pi reports them (shared/subagents.ts `liveSubagents`). */
  subagents?: string;
  /** The countdown of the agent's questions, while they wait (QuestionsCard): its length, end or what was left. */
  askTimeout?: number;
  askDeadline?: number;
  askLeft?: number;
}

/** What a page shows of a chat it does not render (the ATP page's orchestrator): select it with useAppShallow. */
export interface ChatGlance {
  /** Something was sent: the chat has items or runs. */
  talked: boolean;
  running: boolean;
  /** Changes when an item is added or the run starts or ends, not while an answer streams into its item (unread). */
  mark: string;
}

export function chatGlance(session: SessionState | undefined): ChatGlance | undefined {
  return session && { talked: session.items.length > 0 || session.running, running: session.running, mark: `${session.items.length}:${session.running}` };
}

export interface ProjectRow {
  key: string;
  time?: number;
  summary?: SessionSummary;
  live?: OpenChat;
  pinned?: boolean;
}

/** A row's session file: the open chat's (pi can switch it), else the indexed one; none for a chat not saved yet. */
export const rowSession = (row: ProjectRow): string | undefined => row.live?.sessionPath ?? row.summary?.path;

/** Pinned rows first, then the rest; chats not in the index yet (just started) have no time and stay on top until it catches up. */
const byPinThenTime = (a: ProjectRow, b: ProjectRow) =>
  Number(!!b.pinned) - Number(!!a.pinned) || (b.time ?? Number.POSITIVE_INFINITY) - (a.time ?? Number.POSITIVE_INFINITY);

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
export function projectViews(projects: ProjectGroup[], open: OpenChat[], pinned: string[], hidden: string[] = [], pinnedChats: string[] = []): ProjectView[] {
  const groups = new Map<string, { cwd: string; activeAt: number; rows: ProjectRow[] }>();
  for (const project of projects) {
    const sessions = project.sessions.filter((summary) => !(summary.named && isTriage(summary.title)));
    if (!sessions.length) continue;
    const rows = sessions.map((summary) => ({ key: summary.path, time: summary.promptedAt, summary }));
    groups.set(project.cwd, { cwd: project.cwd, activeAt: Math.max(...sessions.map((summary) => summary.promptedAt)), rows });
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
      rows: rows.map(pinRow(pinnedChats)).sort(byPinThenTime),
    }));
}

/** The rows of the projects listed (not hidden), merged into one list newest first: the sidebar's Recent view. */
export function recentRows(views: ProjectView[]): ProjectRow[] {
  return views
    .filter((view) => !view.hidden)
    .flatMap((view) => view.rows)
    .sort(byPinThenTime);
}

function pinRow(pinnedChats: string[]): (row: ProjectRow) => ProjectRow {
  if (!pinnedChats.length) return (row) => row;
  return (row) => {
    const session = rowSession(row);
    return session && pinnedChats.includes(session) ? { ...row, pinned: true } : row;
  };
}

// ── Pins ─────────────────────────────────────────────────────────────────────

export function usePinnedProjects(): string[] {
  return useStore(uiStore, (state) => state.pins);
}

/** New pins go below the existing ones, so pinned projects keep their places. */
export function togglePinnedProject(cwd: string): void {
  applyUi({ type: uiStore.get().pins.includes(cwd) ? "unpin" : "pin", cwd });
}

export function usePinnedChats(): string[] {
  return useStore(uiStore, (state) => state.chats);
}

export function setChatPinned(session: string, pinned: boolean): void {
  applyUi({ type: pinned ? "pinChat" : "unpinChat", session });
}

// ── Hidden ───────────────────────────────────────────────────────────────────

export function useHiddenProjects(): string[] {
  return useStore(uiStore, (state) => state.hidden);
}

/** Hiding unpins too. A new chat in a hidden project brings it back (state/app.ts newSession). */
export function setProjectHidden(cwd: string, hidden: boolean): void {
  applyUi({ type: hidden ? "hide" : "unhide", cwd });
}
