// The Laments page's view of the laments: which projects have them, how bad a project's are, and their chats; and
// what a lament's Fix chat is asked to do (src/shared/task-prompts.ts).
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { type Lament, type LamentFix, type LamentReport, type Laments, lamentSeverity, projectLaments, SEVERITIES, SEVERITY, type Severity } from "../../../shared/laments";
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

/** The text color of a severity's name: the emoji alone read as a mood, not a rank, so the word carries it. */
export const SEVERITY_TONE: Record<Severity, string> = { annoying: "text-muted", costly: "text-warn", blocking: "text-bad" };

/** The line under a lament's title: its latest report. */
export function lamentSnippet(lament: Lament): string {
  return (lament.reports.at(-1)?.text ?? "").replace(/\s+/g, " ").trim();
}

/** What opens the chat that filed a report. */
export function reportChat(projects: ProjectGroup[], report: LamentReport): SessionSummary | undefined {
  return report.chat && chatSummary(projects, { ...report.chat, at: report.at });
}

/** What opens a Fix chat of the lament. */
export function fixChat(projects: ProjectGroup[], fix: LamentFix): SessionSummary {
  return chatSummary(projects, { ...fix.chat, at: fix.at });
}

