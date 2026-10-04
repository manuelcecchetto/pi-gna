// The Projects and Chats lists, from the host's session index and the live chats' attention summaries. Order is the
// desktop sidebar's (renderer/src/lib/projects.ts): pinned folders first, then by latest activity.
import type { AttentionSummary } from "../shared/host-api";
import type { ProjectGroup } from "../shared/ipc";
import type { Attention } from "../shared/session-state";
import { projectViews } from "../renderer/src/lib/projects";

const RANK: Record<Attention, number> = { waiting: 4, running: 3, failed: 2, unread: 1, idle: 0 };

export interface ProjectItem {
  cwd: string;
  pinned: boolean;
  chats: number;
  /** The strongest mark among the project's live chats; absent when none needs you. */
  attention?: Attention;
  time?: number;
}

export interface ChatItem {
  /** The session file. */
  path: string;
  title: string;
  time?: number;
  /** The live chat's handle, when pi is running it now. */
  handle?: string;
  attention?: Attention;
}

const marked = (summary: AttentionSummary | undefined): Attention | undefined => (summary && summary.attention !== "idle" ? summary.attention : undefined);

const strongest = (levels: (Attention | undefined)[]): Attention | undefined =>
  levels.reduce<Attention | undefined>((best, level) => (level && (!best || RANK[level] > RANK[best]) ? level : best), undefined);

const bySessionPath = (attention: Record<string, AttentionSummary>) => new Map(Object.values(attention).flatMap((s) => (s.sessionPath ? [[s.sessionPath, s] as const] : [])));

export function projectItems(projects: ProjectGroup[], pins: string[], attention: Record<string, AttentionSummary>): ProjectItem[] {
  const live = bySessionPath(attention);
  return projectViews(projects, [], pins).map((view) => ({
    cwd: view.cwd,
    pinned: view.pinned,
    chats: view.rows.length,
    attention: strongest(view.rows.map((row) => marked(row.summary && live.get(row.summary.path)))),
    time: view.rows.reduce<number | undefined>((latest, row) => (row.time !== undefined && (latest === undefined || row.time > latest) ? row.time : latest), undefined),
  }));
}

export function chatItems(projects: ProjectGroup[], pins: string[], attention: Record<string, AttentionSummary>, cwd: string): ChatItem[] {
  const live = bySessionPath(attention);
  const view = projectViews(projects, [], pins).find((candidate) => candidate.cwd === cwd);
  return (view?.rows ?? []).flatMap((row) => {
    if (!row.summary) return [];
    const summary = live.get(row.summary.path);
    return [{ path: row.summary.path, title: row.summary.title, time: row.time, handle: summary?.handle, attention: marked(summary) }];
  });
}
