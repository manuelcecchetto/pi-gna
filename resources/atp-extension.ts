// pi extension loaded into ATP orchestrator chats only (`pi -e`, see src/main/session-host.ts). Registers atp_pause
// and atp_resume, which hold pi-gna's runner for a plan while the orchestrator changes it: the runner claims no new
// node while the plan is paused. Calls go through pi-gna's token-gated localhost bridge (src/main/atp.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

const plan = Type.String({ description: "Absolute path of the plan's .atp.json file" });

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;

  async function call(body: { action: "pause" | "resume"; plan: string }, signal?: AbortSignal) {
    const response = await fetch(`${BRIDGE}/atp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json()) as { text?: string; error?: string };
    if (!response.ok) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
    return { content: [{ type: "text" as const, text: data.text ?? "" }], details: {} };
  }

  pi.registerTool({
    name: "atp_pause",
    label: "Pause ATP plan",
    description:
      "Pause pi-gna's runner for an ATP plan before changing it: no new node is claimed until atp_resume. Waits (up to 4 minutes) until no worker holds a node, then returns; if a worker is still running then, it says which and the plan stays paused: call atp_pause again to keep waiting.",
    promptGuidelines: ["Call atp_pause before changing a running ATP plan with the librarian, and atp_resume right after the change."],
    executionMode: "sequential",
    parameters: Type.Object({ plan }),
    async execute(_id, params, signal) {
      return call({ action: "pause", plan: params.plan }, signal);
    },
  });

  pi.registerTool({
    name: "atp_resume",
    label: "Resume ATP plan",
    description: "Let pi-gna's runner claim nodes of an ATP plan again after atp_pause. A plan the user stopped stays stopped until they start it.",
    executionMode: "sequential",
    parameters: Type.Object({ plan }),
    async execute(_id, params, signal) {
      return call({ action: "resume", plan: params.plan }, signal);
    },
  });
}
