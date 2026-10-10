// pi extension loaded into every pi-gna session (`pi -e`). Registers kanban_* tools for the project's Kanban board
// in pi-gna: a chat takes cards (any number), moves them between columns and reports progress on them. Calls go
// through pi-gna's token-gated localhost bridge, which knows the calling chat from its token.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { COLUMNS, type KanbanRequest, type KanbanResponse, LIMITS } from "../src/shared/board";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

const ABOUT =
  "The Kanban board in pi-gna holds this project's tasks as cards in columns todo, in_progress, in_review and done; the user watches it. ";
const column = (description: string) => Type.Optional(StringEnum(COLUMNS, { description }));
const tags = (description: string) =>
  Type.Optional(
    Type.Array(Type.String(), {
      maxItems: LIMITS.tags,
      description: `${description}: at most ${LIMITS.tags} short lowercase topics such as "ui" or "build" (at most ${LIMITS.tag} characters each); reuse the board's tags where they fit`,
    }),
  );

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;

  async function call(body: KanbanRequest, signal?: AbortSignal) {
    const response = await fetch(`${BRIDGE}/kanban`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json()) as KanbanResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
    return { content: [{ type: "text" as const, text: data.text }], details: { card: data.card } };
  }

  pi.registerTool({
    name: "kanban_list",
    label: "Kanban board",
    description: `${ABOUT}List the board's cards by column with their ids and latest report, or pass card to read one card in full (notes and reports).`,
    promptGuidelines: [
      "When you work on a card from the pi-gna Kanban board (the user's message names it, or they ask you to take one), keep it current: kanban_update with column in_progress when you start and in_review with a short report for the user when you finish. Do not create, claim or move cards otherwise.",
      "A chat can work on several cards; when this chat has more than one, pass card to kanban_update to say which one.",
      "When a reply mentions a card, link it in place as [label](card:<id>) so it opens the card; a bare id in backticks renders as code, not a link.",
    ],
    parameters: Type.Object({
      column: column("Only this column"),
      card: Type.Optional(Type.String({ description: "A card id: show this card in full" })),
    }),
    async execute(_id, params, signal) {
      return call({ action: "list", ...params }, signal);
    },
  });

  pi.registerTool({
    name: "kanban_claim",
    label: "Take a Kanban card",
    description: `${ABOUT}Put this chat on a card: pass card (an id from kanban_list), or title and notes to create a card. A chat can work on several cards; claiming one keeps the others.`,
    executionMode: "sequential",
    parameters: Type.Object({
      card: Type.Optional(Type.String({ description: "Id of an existing card" })),
      title: Type.Optional(Type.String({ description: `Title of a new card (at most ${LIMITS.title} characters)` })),
      notes: Type.Optional(Type.String({ description: "Details of a new card" })),
      tags: tags("Tags of a new card"),
      column: column("Move the card to this column too (new cards start in in_progress)"),
    }),
    async execute(_id, params, signal) {
      return call({ action: "claim", ...params }, signal);
    },
  });

  pi.registerTool({
    name: "kanban_update",
    label: "Update Kanban card",
    description: `${ABOUT}Move a card to another column and/or add a progress report the user reads on it; title and tags rename and retag it, leave takes this chat off it. Without card it changes this chat's card (pass card when the chat has several). Use in_review when the work is ready for the user to check, done only when they confirmed it.`,
    executionMode: "sequential",
    parameters: Type.Object({
      card: Type.Optional(Type.String({ description: "Id of the card to change; default: this chat's card" })),
      column: column("New column for the card"),
      title: Type.Optional(Type.String({ description: `New title for the card (at most ${LIMITS.title} characters)` })),
      tags: tags("Replace the card's tags"),
      report: Type.Optional(Type.String({ description: `Short progress note for the user: what changed, what is left (at most ${LIMITS.report} characters)` })),
      leave: Type.Optional(Type.Boolean({ description: "Take this chat off the card" })),
    }),
    async execute(_id, params, signal) {
      return call({ action: "update", ...params }, signal);
    },
  });
}
