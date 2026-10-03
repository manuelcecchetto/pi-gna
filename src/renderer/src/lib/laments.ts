// The Laments page's view of the laments: which projects have them, how bad a project's are, and their chats.
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { type Lament, type LamentReport, type Laments, lamentSeverity, projectLaments, SEVERITIES, type Severity } from "../../../shared/laments";
import { chatSummary } from "./board";

/** Projects the laments page can switch to: the sidebar's, then others that have laments; `current` always. */
export function lamentProjects(laments: Laments, projects: ProjectGroup[], current: string): { cwd: string; open: number }[] {
  const cwds = [...new Set([current, ...projects.map((project) => project.cwd), ...laments.laments.map((lament) => lament.cwd)])];
  return cwds.map((cwd) => ({ cwd, open: projectLaments(laments, cwd).length }));
}

/** The worst of some laments, for a mark that sums them up. */
export function worstSeverity(laments: Lament[]): Severity | undefined {
  let worst = -1;
  for (const lament of laments) worst = Math.max(worst, SEVERITIES.indexOf(lamentSeverity(lament)));
  return SEVERITIES[worst];
}

/** The line under a lament's title: its latest report. */
export function lamentSnippet(lament: Lament): string {
  return (lament.reports.at(-1)?.text ?? "").replace(/\s+/g, " ").trim();
}

/** What opens the chat that filed a report. */
export function reportChat(projects: ProjectGroup[], report: LamentReport): SessionSummary | undefined {
  return report.chat && chatSummary(projects, { ...report.chat, at: report.at });
}
