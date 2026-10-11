// pi extension loaded into every pi-gna chat but ATP's (`pi -e`). Registers ask_user: the agent stops and asks the
// user one or more questions on a card that takes the composer's place; each has a default, taken when the countdown
// runs out. pi's questionnaire example draws its UI in the terminal (`ctx.ui.custom`, which RPC mode lacks), so the
// card is pi-gna's; the arguments and result details follow that example. Calls go through pi-gna's token-gated
// localhost bridge, which knows the calling chat from its token.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ASK_DEFAULT_TIMEOUT_SEC, ASK_LIMITS, ASK_MAX_TIMEOUT_SEC, type AskParams, type AskRequest, type AskResponse, type AskResult } from "../src/shared/ask";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;

  async function call(body: AskRequest, signal?: AbortSignal): Promise<AskResponse> {
    const response = await fetch(`${BRIDGE}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json()) as AskResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
    return data;
  }

  pi.registerTool({
    name: "ask_user",
    label: "Ask the user",
    description: `Stop and ask the user up to ${ASK_LIMITS.questions} questions in pi-gna, one at a time on a card in place of their message box. Each question is single or multiple choice over its options, with an optional free-form answer ("Something else…"), or free form only (no options). Give each question a default: the answer you would pick yourself. A countdown (default ${ASK_DEFAULT_TIMEOUT_SEC}s) sends the defaults when the user does not respond; it stops as soon as they touch the card. Returns each answer, marked (default) or (skipped) when the user did not choose it, and "(not answered)" when there was nothing to take.`,
    promptGuidelines: [
      "Use ask_user when a decision is the user's to make and guessing wrong would waste real work (which approach, scope, a destructive or outward step); not for things you can find out yourself, and not to confirm what the user already said. Ask everything you need in one call.",
      "Give every ask_user question a default, the option you would choose, so the work goes on if the user is away. An answer marked (default) was not chosen by the user: say so where it matters.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ description: "Short id for this question (default q1, q2, …)" })),
          prompt: Type.String({ description: "The question, shown as the card's heading" }),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String({ description: "The option, as the user sees and the answer returns it" }),
                description: Type.Optional(Type.String({ description: "A short line under the option" })),
              }),
              { maxItems: ASK_LIMITS.options, description: "The choices; leave out for a free-form question" },
            ),
          ),
          multi: Type.Optional(Type.Boolean({ description: "Let the user pick several options (default: one)" })),
          allowOther: Type.Optional(Type.Boolean({ description: 'Offer a free-form "Something else…" answer (default true)' })),
          default: Type.Optional(
            Type.Union([Type.String(), Type.Array(Type.String())], {
              description: "The default answer: an option's label (several for multi), or free text. Without one, a timeout answers (not answered)",
            }),
          ),
        }),
        { minItems: 1, maxItems: ASK_LIMITS.questions },
      ),
      timeoutSec: Type.Optional(
        Type.Number({ description: `Seconds before the defaults are sent (default ${ASK_DEFAULT_TIMEOUT_SEC}, at most ${ASK_MAX_TIMEOUT_SEC}; 0 waits for the user)` }),
      ),
    }),
    async execute(_id, params, signal) {
      const started = await call({ action: "start", params: params as AskParams }, signal);
      if (!("id" in started)) throw new Error("pi-gna did not take the questions");
      const { id } = started;
      try {
        for (;;) {
          const answer = await call({ action: "wait", id }, signal);
          if ("done" in answer && answer.done) return { content: [{ type: "text" as const, text: answer.text }], details: answer.details satisfies AskResult };
        }
      } catch (error) {
        // Aborted (Esc) or the wait failed: take the card down.
        await call({ action: "cancel", id }).catch(() => {});
        throw error;
      }
    },
  });
}
