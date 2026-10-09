// The chat list's shape: session summaries grouped by project (projectOf their cwd: a card's worktree counts as its
// project), chats and projects newest first. The host builds it from a listing of the sessions folder (listSessions);
// after a run settles it re-indexes only that chat's file and every client patches its list with it
// (`session.indexed`, patchProjects).
import { projectOf } from "./board";
import type { ProjectGroup, SessionSummary } from "./ipc";

export function groupSessions(summaries: Iterable<SessionSummary | undefined>): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const summary of summaries) {
    if (!summary) continue;
    const cwd = projectOf(summary.cwd);
    const group = groups.get(cwd) ?? { cwd, modifiedAt: 0, sessions: [] };
    group.sessions.push(summary);
    group.modifiedAt = Math.max(group.modifiedAt, summary.modifiedAt);
    groups.set(cwd, group);
  }
  for (const group of groups.values()) group.sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return [...groups.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * The list with the row for `path` replaced by `summary`, added when new, or dropped when null (a file that lists
 * nothing); the same list when nothing changes, so its readers do not render again.
 */
export function patchProjects(projects: ProjectGroup[], path: string, summary: SessionSummary | null): ProjectGroup[] {
  const current = projects.flatMap((group) => group.sessions).find((session) => session.path === path);
  if (summary ? current && sameSummary(current, summary) : !current) return projects;
  const others = projects.flatMap((group) => group.sessions.filter((session) => session.path !== path));
  return groupSessions(summary ? [...others, summary] : others);
}

function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  return a.id === b.id && a.cwd === b.cwd && a.title === b.title && a.named === b.named && a.createdAt === b.createdAt && a.modifiedAt === b.modifiedAt;
}
