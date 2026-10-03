// pi extension loaded into every pi-gna session (`pi -e`). Registers the lament tool: when a tool or capability the
// agent needs is missing, unavailable or failing, it files a lament on the project's Lamenting board in pi-gna and
// carries on. Calls go through pi-gna's token-gated localhost bridge, which knows the calling chat from its token.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LAMENT_LIMITS, type LamentRequest, type LamentResponse, SEVERITIES, SEVERITY } from "../src/shared/laments";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

const severities = SEVERITIES.map((severity) => `${severity}: ${SEVERITY[severity].about}`).join("; ");

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;

  pi.registerTool({
    name: "lament",
    label: "Lament",
    description:
      "File a lament on pi-gna's Lamenting board for this project: a tool or capability you needed was missing, unavailable, hard to find or failing, so you had to work around it or could not do the thing. The user reads the board to fix their tooling. After filing, carry on with the best workaround.",
    promptGuidelines: [
      "When meaningful friction shows that a tool or capability you need is missing, unavailable, hard to find or failing (repeated manual reconciliation, polling or rediscovery, a brittle multi-step workaround, or something you could not verify), call lament right away, at the point of friction, then carry on with the best workaround you are allowed. Lament friction you observed, not wish lists or ordinary one-off errors, and look for a tool before you call it absent. Hit the same gap again: pass its id as repeats instead of filing it twice. Keep secrets and private content out. Mention a lament to the user only when the gap blocks you or needs them to act.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      title: Type.String({ description: `The missing capability, short and specific (at most ${LAMENT_LIMITS.title} characters), e.g. "No way to record a browser tab to video"` }),
      body: Type.String({
        description: `Markdown, a few short paragraphs (at most ${LAMENT_LIMITS.text} characters): what you were doing; what happened, with evidence (failed attempts, repeated steps); the tools you checked and whether the capability is absent, not connected, hard to find or failing; the operation you wanted, with its inputs and outputs, and which tool could be extended; your workaround and what it cost.`,
      }),
      severity: StringEnum(SEVERITIES, { description: `How bad it was: ${severities}` }),
      repeats: Type.Optional(Type.String({ description: "Id of an open lament on this project's board that this repeats: adds your report to it instead of filing a new one" })),
    }),
    async execute(_id, params, signal) {
      const body: LamentRequest = params;
      const response = await fetch(`${BRIDGE}/lament`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
        signal,
      });
      const data = (await response.json()) as LamentResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
      return { content: [{ type: "text" as const, text: data.text }], details: { lament: data.lament } };
    },
  });
}
