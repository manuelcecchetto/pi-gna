// What the phone's Settings pages decide without React: the sections it offers, the update line and how a refused
// change reads. Providers, the keyboard shortcuts and the host-UI buttons (Finder, System Settings, Restart) stay on the Mac.
import type { UpdateState } from "../shared/ipc";
import type { Feature, Task } from "../shared/settings";
import { SETTINGS_SECTIONS } from "../shared/settings";

/** The Settings sections of the desktop page the phone has, plus Updates, which the desktop shows inside General. */
export const MOBILE_SECTIONS = ["general", "appearance", "models", "agent", "features", "computer", "remote", "updates"] as const;
export type MobileSection = (typeof MOBILE_SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<MobileSection, string>> = {
  general: "General",
  appearance: "Appearance",
  models: "Models",
  agent: "Agent",
  features: "Features",
  computer: "Computer use",
  remote: "Remote access",
  updates: "Updates",
};

/** Desktop sections the phone leaves out on purpose. */
export const HOST_ONLY_SECTIONS = SETTINGS_SECTIONS.filter((section) => !(MOBILE_SECTIONS as readonly string[]).includes(section));

export const isMobileSection = (value: unknown): value is MobileSection => MOBILE_SECTIONS.includes(value as MobileSection);

/** The chats pi-gna starts, with the feature each belongs to (a task of a feature that is off is not offered). */
export const TASK_INFO: Record<Task, { title: string; about: string; feature: Feature }> = {
  triage: { title: "Card triage", about: "Names, tags and briefly looks into every card you add.", feature: "kanban" },
  orchestrator: { title: "ATP orchestrator", about: "Writes and changes ATP plans with you.", feature: "atp" },
  worker: { title: "ATP worker", about: "Runs one node of a plan, in a fresh chat per node.", feature: "atp" },
};

export function updateSummary(update: UpdateState): string {
  if (update.phase === "idle") return "pi-gna is up to date.";
  const { version } = update.release;
  if (update.phase === "available") return `pi-gna ${version} is available.`;
  if (update.phase === "downloading") return update.progress < 1 ? `Downloading ${version}… ${Math.round(update.progress * 100)}%` : `Checking ${version}…`;
  if (update.phase === "ready") return `${version} is ready. Restart pi-gna on the Mac to install it.`;
  return `Updating to ${version} failed: ${update.error}`;
}

/** Whether the Download button applies: an update that can be fetched, not one that needs the release page. */
export const canDownload = (update: UpdateState): boolean => (update.phase === "available" && !update.manual) || update.phase === "failed";

/** A refused change as the phone says it; a conflict means the value changed on another device meanwhile. */
export function changeError(error: unknown): { text: string; conflict: boolean } {
  const text = error instanceof Error ? error.message : String(error);
  return text.startsWith("Conflict:") ? { text: "That changed elsewhere meanwhile; the latest value is shown. Change it again.", conflict: true } : { text, conflict: false };
}
