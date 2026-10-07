// The Projects and Chats lists, from the host's session index and the live chats' attention summaries. Order is the
// desktop sidebar's (renderer/src/lib/projects.ts): pinned folders first, then by latest activity. Like the sidebar,
// they show live chats the index has no row for yet (pi writes the file with the first message; the index is re-read).
import { projectOf } from "../shared/board";
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

/** Live chats the lists show that have no index row yet, newest started first. */
function unindexed(projects: ProjectGroup[], attention: Record<string, AttentionSummary>): (AttentionSummary & { sessionPath: string })[] {
  const indexed = new Set(projects.flatMap((project) => project.sessions.map((session) => session.path)));
  return Object.values(attention)
    .filter((s): s is AttentionSummary & { sessionPath: string } => s.listed && !!s.sessionPath && !indexed.has(s.sessionPath))
    .reverse();
}

export function projectItems(projects: ProjectGroup[], pins: string[], attention: Record<string, AttentionSummary>, seen?: SeenMarks): ProjectItem[] {
  const live = bySessionPath(attention);
  const items = projectViews(projects, [], pins).map((view) => ({
    cwd: view.cwd,
    pinned: view.pinned,
    chats: view.rows.length,
    attention: strongest(view.rows.map((row) => marked(row.summary && live.get(row.summary.path), seen))),
    titles: view.rows.flatMap((row) => (row.summary ? [row.summary.title] : [])),
    time: view.rows.reduce<number | undefined>((latest, row) => (row.time !== undefined && (latest === undefined || row.time > latest) ? row.time : latest), undefined),
  }));
  const fresh = new Set<string>();
  for (const summary of unindexed(projects, attention)) {
    const cwd = projectOf(summary.cwd);
    let item = items.find((candidate) => candidate.cwd === cwd);
    if (!item) items.push((item = { cwd, pinned: pins.includes(cwd), chats: 0, attention: undefined, titles: [], time: undefined }));
    item.chats++;
    item.attention = strongest([item.attention, marked(summary, seen)]);
    item.titles.push(summary.title);
    fresh.add(cwd);
  }
  // A project with a chat not indexed yet was just active: it goes above the other unpinned ones, as on the desktop.
  const rank = (item: ProjectItem) => (item.pinned ? pins.indexOf(item.cwd) : fresh.has(item.cwd) ? pins.length : pins.length + 1);
  return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
}

export function chatItems(projects: ProjectGroup[], pins: string[], attention: Record<string, AttentionSummary>, cwd: string, seen?: SeenMarks): ChatItem[] {
  const live = bySessionPath(attention);
  const view = projectViews(projects, [], pins).find((candidate) => candidate.cwd === cwd);
  // Chats not in the index yet have no time and stay on top until it catches up, as on the desktop.
  const fresh = unindexed(projects, attention)
    .filter((summary) => projectOf(summary.cwd) === cwd)
    .map((summary) => ({ path: summary.sessionPath, title: summary.title, handle: summary.handle, attention: marked(summary, seen), settledAt: summary.settled?.at }));
  return [
    ...fresh,
    ...(view?.rows ?? []).flatMap((row) => {
      if (!row.summary) return [];
      const summary = live.get(row.summary.path);
      return [{ path: row.summary.path, title: row.summary.title, time: row.time, handle: summary?.handle, attention: marked(summary, seen), settledAt: summary?.settled?.at }];
    }),
  ];
}

/** Projects whose name, path or any chat title matches; the unfiltered list for an empty query. */
export function searchProjects(items: ProjectItem[], query: string): ProjectItem[] {
  if (!query.trim()) return items;
  return fuzzyFilter(items, query, (item: ProjectItem) => `${item.cwd} ${item.titles.join(" ")}`, items.length);
}

export function searchChats(items: ChatItem[], query: string): ChatItem[] {
  return query.trim() ? fuzzyFilter(items, query, (item: ChatItem) => item.title, items.length) : items;
}
