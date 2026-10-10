// Which pi session is whose work: the surface that ran it (a pi-gna feature, a CI runner, pi itself), the project it
// belongs to and whether pi-gna ran it. Pure: the extractor passes what the file says (usage-extract.ts), and
// docs/DESIGN.md "Usage" > Sources and surfaces has the rules.
import { cardOfWorktree, projectOf } from "./board";
import type { SessionMarkers, SourceRoot, Surface } from "./usage";

/** Names only pi-gna's own tools and prompts put in a system message (kanban_, threads_, lament: its tools; pigna-visual-prompt: its prompt). */
export const PIGNA_MARKERS = ["kanban_", "threads_", "lament", "pigna-visual-prompt"] as const;

/** The first prompt of a chat that pi-gna's ATP runner started. */
export const ATP_RUNTIME_PREFIX = "### Runtime Context (Injected by pi-gna's ATP runner)";

const RUNNERS = /[\\/]actions-runners?[\\/]/;
const RUNNER_REPO = /[\\/]_work[\\/]([^\\/]+)/;
const SUBAGENT_DIR = /[\\/]tasks[\\/]/;
const CI_PREFIX = "ci:";

export interface SessionEvidence {
  root: SourceRoot;
  path: string;
  cwd: string;
  /** The header's parentSession, which only a subagent's header has. */
  parentId?: string;
  markers: SessionMarkers;
}

export interface SessionPlacement {
  project: string;
  surface: Surface;
  isPigna: boolean;
  card?: string;
}

/** A card worktree folds into its project; every CI runner of one repository shares one project. */
export function projectKey(cwd: string): string {
  if (!RUNNERS.test(cwd)) return projectOf(cwd);
  return `${CI_PREFIX}${RUNNER_REPO.exec(cwd)?.[1] ?? "runner"}`;
}

/**
 * The first surface the session's evidence matches: subagent, ATP worker, CI, card, pi-gna chat, else terminal.
 * `parentPigna` is the parent's pigna flag, which a subagent takes.
 */
export function classifySession(evidence: SessionEvidence, parentPigna = false): SessionPlacement {
  const { root, path, cwd, parentId, markers } = evidence;
  const card = cardOfWorktree(cwd);
  const placed = (surface: Surface, isPigna: boolean): SessionPlacement => ({ project: projectKey(cwd), surface, isPigna, card });
  if (parentId !== undefined && SUBAGENT_DIR.test(path)) return placed("subagent", parentPigna);
  if (root === "atp" || markers.atpRuntime) return placed("atp-worker", true);
  if (RUNNERS.test(cwd)) return placed("ci", false);
  if (card !== undefined) return placed("card", true);
  if (markers.pignaTools) return placed("pigna-chat", true);
  return placed("terminal", false);
}

/** Whether a system message's text (a string or a Buffer) names one of pi-gna's tools or prompts. */
export function namesPignaTools(text: { includes(search: string): boolean }): boolean {
  return PIGNA_MARKERS.some((marker) => text.includes(marker));
}

export function startsAtpRuntime(prompt: string): boolean {
  return prompt.startsWith(ATP_RUNTIME_PREFIX);
}

/** Each project's last folder names, as many as keep the labels unique; a CI project reads "CI runners (repo)". */
export function projectLabels(projects: readonly string[]): Map<string, string> {
  const depth = new Map<string, number>(projects.map((project) => [project, 1]));
  const segments = (project: string) => project.split(/[\\/]+/).filter(Boolean);
  const labelOf = (project: string): string => {
    if (project.startsWith(CI_PREFIX)) return `CI runners (${project.slice(CI_PREFIX.length)})`;
    return segments(project).slice(-(depth.get(project) ?? 1)).join("/") || project;
  };
  for (;;) {
    const groups = new Map<string, string[]>();
    for (const project of projects) groups.set(labelOf(project), [...(groups.get(labelOf(project)) ?? []), project]);
    let grew = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const project of group) {
        const current = depth.get(project) ?? 1;
        if (project.startsWith(CI_PREFIX) || current >= segments(project).length) continue;
        depth.set(project, current + 1);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return new Map(projects.map((project) => [project, labelOf(project)]));
}
