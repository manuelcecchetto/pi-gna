// What the phone's Settings pages decide without React: the sections it offers, the update line and how a refused
// change reads. The keyboard shortcuts, the plugins (installs run code and sign-ins open a browser on the Mac), the chat
// import (it reads the Mac's Codex and Claude Code history) and the host-UI buttons (Finder, System Settings, Restart) stay on the Mac, and so does About (General and Updates already show
// the phone the version).
import type { UpdateState } from "../shared/ipc";
import type { Feature, Task } from "../shared/settings";
import { SETTINGS_SECTIONS } from "../shared/settings";
import type { UsageProgress, UsageRange, UsageSource } from "../shared/usage";

/** The Settings sections of the desktop page the phone has, plus Updates, which the desktop shows inside General. */
export const MOBILE_SECTIONS = ["general", "appearance", "providers", "models", "agent", "features", "computer", "remote", "usage", "updates"] as const;
export type MobileSection = (typeof MOBILE_SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<MobileSection, string>> = {
  general: "General",
  appearance: "Appearance",
  providers: "Providers",
  models: "Models",
  agent: "Agent",
  features: "Features",
  computer: "Computer use",
  remote: "Remote access",
  usage: "Usage",
  updates: "Updates",
};

export const USAGE_RANGE_LABELS: Record<UsageRange, string> = { "7d": "7d", "14d": "14d", "30d": "30d", "90d": "90d", all: "All" };
export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = { pigna: "pi-gna", all: "All pi" };

/** What the phone's Usage section says while the Mac reads its session files. */
export function usageProgressText(progress: UsageProgress | undefined): string {
  if (progress?.phase === "scan") return "Listing session files…";
  if (progress?.phase === "index") return `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} files`;
  return "Preparing the report…";
}

/** Desktop sections the phone leaves out on purpose. */
export const HOST_ONLY_SECTIONS = SETTINGS_SECTIONS.filter((section) => !(MOBILE_SECTIONS as readonly string[]).includes(section));

export const isMobileSection = (value: unknown): value is MobileSection => MOBILE_SECTIONS.includes(value as MobileSection);

/** The chats pi-gna starts, with the feature each belongs to (a task of a feature that is off is not offered). */
export const TASK_INFO: Record<Task, { title: string; about: string; feature?: Feature }> = {
  title: { title: "Chat titles", about: "Names each chat from its first message. A fast, cheap model is best." },
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
