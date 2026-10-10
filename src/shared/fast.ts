// Fast mode (`/fast`, resources/fast-extension.ts): OpenAI priority processing for GPT models, per chat. The extension
// reports it as the `fast` extension status, which the composers read for their zap; they turn it on and off by
// sending `/fast on|off` as a prompt (pi runs an extension command at once, even mid-run).
import type { SlashCommand } from "./protocol";

/** The providers whose requests take `service_tier: "priority"`: OpenAI's API and ChatGPT (Codex) sign-in. */
export const FAST_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex"]);
export const FAST_STATUS = "fast";

export const fastApplies = (provider: string | undefined): boolean => FAST_PROVIDERS.has(provider ?? "");
export const isFast = (statuses: Record<string, string> | undefined): boolean => statuses?.[FAST_STATUS] === "on";
/**
 * The prompt that switches fast mode. pi renames commands that share a name (another package's /fast makes ours
 * `fast:1`), so the composers find pi-gna's by the file that registered it in get_commands.
 */
export function fastCommand(on: boolean, commands: readonly SlashCommand[] | undefined): string {
  const ours = commands?.find((command) => command.source === "extension" && /[\\/]fast-extension\.ts$/.test(command.sourceInfo?.path ?? ""));
  return `/${ours?.name ?? "fast"} ${on ? "on" : "off"}`;
}

/** The composer's model chip: the model, then its thinking level unless the model only offers off. */
export function modelChipLabel(model: string, level: string | undefined, levels: readonly string[] | undefined): string {
  return level && levels && !(levels.length === 1 && levels[0] === "off") ? `${model} · ${level}` : model;
}

/** Model names more than one provider offers (GPT-5.5 by `openai` and `openai-codex`): those rows also name the provider. */
export function sharedNames(models: readonly { name: string }[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of models) (seen.has(name) ? shared : seen).add(name);
  return shared;
}
