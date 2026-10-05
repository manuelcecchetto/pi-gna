// The phone's board view: what a card row shows, where a dragged card lands, and which actions a card offers (the
// desktop's card-actions.ts conditions, without its React imports).
import { type Board, type BoardOp, type Card, type Column } from "../shared/board";
import { splitAttachments } from "../shared/task-prompts";
import type { Attention } from "../shared/session-state";
import type { AttentionSummary } from "../shared/host-api";

export type CardTask = "investigate" | "resolve" | "qa" | "discuss";

export const CARD_TASKS: { id: CardTask; label: string; hint: string; when: (card: Card) => boolean }[] = [
  { id: "investigate", label: "Investigate", hint: "A new chat looks into it without changing files, and reports on the card", when: () => true },
  { id: "resolve", label: "Resolve", hint: "A new chat makes the change in a git worktree, verifies it and moves the card to review", when: (card) => card.column !== "done" },
  { id: "qa", label: "QA", hint: "A new chat reviews and tries the change without fixing anything", when: (card) => card.column === "in_review" },
  { id: "discuss", label: "Chat about it", hint: "A new chat with the card in its composer", when: () => true },
];

export const cardTasks = (card: Card): typeof CARD_TASKS => CARD_TASKS.filter((task) => task.when(card));

const RANK: Record<Attention, number> = { idle: 0, unread: 1, failed: 2, running: 3, waiting: 4 };

/** What the card's open chats need from you, strongest first (the sidebar's marks, from the live attention summaries). */
export function cardMark(card: Card, attention: Record<string, AttentionSummary>): Attention | undefined {
  const paths = new Set(card.chats.map((chat) => chat.path));
  let best: Attention | undefined;
  for (const summary of Object.values(attention)) {
    if (summary.sessionPath === undefined || !paths.has(summary.sessionPath) || summary.attention === "idle") continue;
    if (!best || RANK[summary.attention] > RANK[best]) best = summary.attention;
  }
  return best;
}

/** How many files a card's notes list under Attachments. */
export const attachmentCount = (card: Card): number => splitAttachments(card.notes).paths.length;

/**
 * The op that drops `id` at `index` among the other cards of its column (`column` is the cards in display order):
 * before the card now at that place, or at the bottom.
 */
export function dropOp(column: Card[], id: string, index: number): BoardOp | undefined {
  const from = column.findIndex((card) => card.id === id);
  if (from < 0) return undefined;
  const rest = column.filter((card) => card.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  // Back where it was: nothing to do.
  if (at === from) return undefined;
  return { type: "move", id, column: (column[from] as Card).column, before: rest[at]?.id ?? null };
}

/** Moving to another column puts the card on top, as the desktop's menu does. */
export const moveToOp = (card: Card, column: Column): BoardOp | undefined => (card.column === column ? undefined : { type: "move", id: card.id, column });

/** The row under a y coordinate, for a drag: the index among the column's rows, by their midpoints. */
export function indexAt(mids: number[], y: number): number {
  let index = 0;
  for (const mid of mids) if (y > mid) index++;
  return index;
}

export const cardById = (board: Board | undefined, id: string | undefined): Card | undefined => (id ? board?.cards.find((card) => card.id === id) : undefined);
