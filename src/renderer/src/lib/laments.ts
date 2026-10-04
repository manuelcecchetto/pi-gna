// The Laments page's view of the laments: which projects have them, how bad a project's are, and their chats; and
// what a lament's Fix chat is asked to do.
import type { CardWorktree, ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { type Lament, type LamentFix, type LamentReport, type Laments, lamentSeverity, projectLaments, SEVERITIES, SEVERITY, type Severity } from "../../../shared/laments";
import { chatSummary, worktreeNote } from "./board";

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

/** What opens a Fix chat of the lament. */
export function fixChat(projects: ProjectGroup[], fix: LamentFix): SessionSummary {
  return chatSummary(projects, { ...fix.chat, at: fix.at });
}

/** Reports a Fix chat reads: how the lament was filed and the latest evidence, each whole. */
const BRIEF_REPORTS = 3;

/** The lament as a chat sees it. */
export function lamentBlock(lament: Lament): string {
  const severity = SEVERITY[lamentSeverity(lament)];
  const lines = [`Lament ${lament.id}: ${lament.title}`, `Severity: ${severity.emoji} ${severity.label} (${severity.about})`];
  if (lament.reports.length > 1) lines.push(`Hit ${lament.reports.length} times`);
  const [first, ...rest] = lament.reports;
  const latest = rest.slice(1 - BRIEF_REPORTS);
  const skipped = rest.length - latest.length;
  lines.push("", `Reports, oldest first${skipped ? ` (${skipped} in between left out)` : ""}:`);
  for (const report of [first, ...latest]) {
    if (report) lines.push("", `--- ${SEVERITY[report.severity].label}, ${new Date(report.at).toISOString().slice(0, 16).replace("T", " ")}Z`, report.text);
  }
  return `<lament>\n${lines.join("\n")}\n</lament>`;
}

/** `worktree`: where the chat works (null: the project is not in git, so it works in the project folder). */
export function fixPrompt(lament: Lament, worktree: CardWorktree | null = null): string {
  return [
    "Fix the gap this lament from the project's Lamenting board describes, so the next agent does not hit it: make the change, verify it, and tell me what you did.",
    lamentBlock(lament),
    [
      "An agent filed it when a tool or capability it needed was missing, unavailable, hard to find or failing, and worked around it.",
      "Find the cause: the project's own code, scripts and docs, its .pi folder (extensions, skills, AGENTS.md), or the tool the agent used.",
      "Fix the cause rather than adding another workaround, then verify the fix by doing what the lament wanted to do.",
      "Where the fix belongs outside this project (pi's global setup in ~/.pi/agent, another repository, an app or a permission), do not change it there: tell me what to change and why.",
    ].join(" "),
    ...(worktree ? [worktreeNote(lament.cwd, worktree, "lament")] : []),
    "I mark the lament resolved once your fix is in, so do not file it again while you work on it. End with what changed, how you verified it and what is left for me.",
  ].join("\n\n");
}
