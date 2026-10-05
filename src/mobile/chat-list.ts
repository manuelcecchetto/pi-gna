// The Projects and Chats lists, from the host's session index and the live chats' attention summaries. Order is the
// desktop sidebar's (renderer/src/lib/projects.ts): pinned folders first, then by latest activity.
import type { AttentionSummary } from "../shared/host-api";
import type { ProjectGroup } from "../shared/ipc";
import type { Attention } from "../shared/session-state";
import { fuzzyFilter } from "../renderer/src/lib/fuzzy";
import { projectViews } from "../renderer/src/lib/projects";

/** When this device last opened each live chat, as the chat's `settled.at` then (host clock): later activity is unread again. */
export type SeenMarks = Record<string, number>;

const RANK: Record<Attention, number> = { waiting: 4, running: 3, failed: 2, unread: 1, idle: 0 };

export interface ProjectItem {
  cwd: string;
  pinned: boolean;
  chats: number;
  /** The strongest mark among the project's live chats; absent when none needs you. */
  attention?: Attention;
  time?: number;
  /** Titles of its chats, for the search. */
  titles: string[];
}

export interface ChatItem {
  /** The session file. */
  path: string;
  title: string;
  time?: number;
  /** The live chat's handle, when pi is running it now. */
  handle?: string;
  attention?: Attention;
  /** The live chat's last settle time, to record as seen when opened. */
  settledAt?: number;
}

// "Unread" is per device: a chat this phone already opened for that outcome shows no mark here, whatever other clients did.
const marked = (summary: AttentionSummary | undefined, seen: SeenMarks = {}): Attention | undefined => {
  if (!summary || summary.attention === "idle") return undefined;
  if (summary.attention === "unread" && summary.settled && (seen[summary.handle] ?? -1) >= summary.settled.at) return undefined;
  return summary.attention;
};

const strongest = (levels: (Attention | undefined)[]): Attention | undefined =>
  levels.reduce<Attention | undefined>((best, level) => (level && (!best || RANK[level] > RANK[best]) ? level : best), undefined);

const bySessionPath = (attention: Record<string, AttentionSummary>) => new Map(Object.values(attention).flatMap((s) => (s.sessionPath ? [[s.sessionPath, s] as const] : [])));

export function projectItems(projects: ProjectGroup[], pins: string[], attention: Record<string, AttentionSummary>, seen?: SeenMarks): ProjectItem[] {
  const live = bySessionPath(attention);
  return projectViews(projects, [], pins).map((view) => ({
    cwd: view.cwd,
    pinned: view.pinned,
    chats: view.rows.length,
    attention: strongest(view.rows.map((row) => marked(row.summary && live.get(row.summary.path), seen))),
    titles: view.rows.flatMap((row) => (row.summary ? [row.summary.title] : [])),
    time: view.rows.reduce<number | undefined>((latest, row) => (row.time !== undefined && (latest === undefined || row.time > latest) ? row.time : latest), undefined),
  }));
}

export function chatItems(projects: ProjectGroup[], pins: string[], attention: Record<string, AttentionSummary>, cwd: string, seen?: SeenMarks): ChatItem[] {
  const live = bySessionPath(attention);
  const view = projectViews(projects, [], pins).find((candidate) => candidate.cwd === cwd);
  return (view?.rows ?? []).flatMap((row) => {
    if (!row.summary) return [];
    const summary = live.get(row.summary.path);
    return [{ path: row.summary.path, title: row.summary.title, time: row.time, handle: summary?.handle, attention: marked(summary, seen), settledAt: summary?.settled?.at }];
  });
}

/** Projects whose name, path or any chat title matches; the unfiltered list for an empty query. */
export function searchProjects(items: ProjectItem[], query: string): ProjectItem[] {
  if (!query.trim()) return items;
  return fuzzyFilter(items, query, (item: ProjectItem) => `${item.cwd} ${item.titles.join(" ")}`, items.length);
}

export function searchChats(items: ChatItem[], query: string): ChatItem[] {
  return query.trim() ? fuzzyFilter(items, query, (item: ChatItem) => item.title, items.length) : items;
}
