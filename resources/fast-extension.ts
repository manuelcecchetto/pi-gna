// pi extension loaded into every pi-gna session (`pi -e`): `/fast` turns OpenAI's priority processing on or off for
// the chat, like Codex's /fast. While on, each request a GPT model (providers `openai` and `openai-codex`) sends
// carries `service_tier: "priority"`: faster output, billed at the priority rate (about 2x; pi-ai prices the usage
// from the tier the response reports). Other models are left alone, so the switch can stay on across a model change.
// The choice is kept in the session file (a custom entry, outside the model's context) and read back on open, and
// shown as the `fast` extension status: the composers' zap reads it and sends `/fast on|off` (src/shared/fast.ts).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAST_STATUS, fastApplies } from "../src/shared/fast";

export const FAST_ENTRY = "pigna-fast";

type Entry = { type: string; customType?: string; data?: { on?: boolean } };

/** The chat's last saved choice; off when it never used /fast. */
export function savedFast(branch: readonly Entry[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "custom" && entry.customType === FAST_ENTRY) return entry.data?.on === true;
  }
  return false;
}

/** `/fast` flips it, `/fast on|off` sets it, `/fast status` only reports. */
export function nextFast(args: string, on: boolean): boolean | "status" | undefined {
  const word = args.trim().toLowerCase();
  if (word === "") return !on;
  if (word === "on") return true;
  if (word === "off") return false;
  if (word === "status") return "status";
  return undefined;
}

const isGpt = (ctx: ExtensionContext) => fastApplies(ctx.model?.provider);

export default function (pi: ExtensionAPI) {
  let on = false;

  const show = (ctx: ExtensionContext) => ctx.ui.setStatus(FAST_STATUS, on ? "on" : undefined);

  pi.on("session_start", (_event, ctx) => {
    on = savedFast(ctx.sessionManager.getBranch() as Entry[]);
    show(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!on || !isGpt(ctx) || !event.payload || typeof event.payload !== "object") return;
    return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
  });

  pi.registerCommand("fast", {
    description: "Toggle fast mode for GPT models (OpenAI priority processing, about 2x the price)",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"].filter((word) => word.startsWith(prefix.trim().toLowerCase())).map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      const next = nextFast(args, on);
      if (next === undefined) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }
      if (next !== "status" && next !== on) {
        on = next;
        pi.appendEntry(FAST_ENTRY, { on });
        show(ctx);
      }
      // The zap shows a change; words only for a status check or a switch that does nothing for this model.
      if (on && !isGpt(ctx)) ctx.ui.notify(`Fast mode is on for GPT models (OpenAI, ChatGPT); ${ctx.model?.id ?? "this model"} is unaffected.`, "info");
      else if (next === "status") ctx.ui.notify(on ? "Fast mode is on: GPT requests use priority processing, about 2x the price." : "Fast mode is off.", "info");
    },
  });
}
