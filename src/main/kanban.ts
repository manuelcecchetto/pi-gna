// POST /kanban on the agent bridge: the kanban_* tools. The calling chat is the session behind the token; it sees
// its project's board (projectOf: a card's worktree counts as its project), and its card is the one its session
// file is attached to (one at a time).
import {
  type Board,
  type Card,
  type Column,
  COLUMN_LABELS,
  COLUMNS,
  cardOfChat,
  freshId,
  isColumn,
  projectCards,
  projectOf,
  type KanbanRequest,
  type KanbanResponse,
} from "../shared/board";
import type { BoardStore } from "./board";
import { bridgeError, type Route } from "./bridge";

/** The calling chat: its session file and project. */
export type Identify = (handle: string) => Promise<{ path: string; cwd: string }>;

const SHOWN_PER_COLUMN = 30;
const SHOWN_DONE = 8;

export function kanbanRoute(board: BoardStore, identify: Identify): Route {
  return async (handle, body): Promise<KanbanResponse> => {
    const request = body as KanbanRequest;
    if (request?.column !== undefined && !isColumn(request.column)) throw bridgeError(400, `unknown column ${String(request.column)}; use one of ${COLUMNS.join(", ")}`);
    const chat = await identify(handle);
    const project = projectOf(chat.cwd);
    const mine = () => board.get().then((current) => cardOfChat(current, chat.path));

    switch (request?.action) {
      case "list": {
        const current = await board.get();
        const own = cardOfChat(current, chat.path);
        if (request.card) return { text: detail(find(current, request.card, project), chat.path), card: own?.id };
        return { text: overview(current, request.column, project, own), card: own?.id };
      }
      case "claim": {
        const previous = await mine();
        let id = request.card;
        if (id) find(await board.get(), id, project);
        else {
          if (!request.title) throw bridgeError(400, "pass card (an id from kanban_list) or title (to create a card)");
          id = freshId(await board.get());
          await board.apply({ type: "add", id, title: request.title, notes: request.notes, tags: request.tags, cwd: project, column: request.column ?? "in_progress" });
        }
        await board.apply({ type: "attach", id, chat: { path: chat.path, cwd: chat.cwd } });
        if (request.column) await board.apply({ type: "report", id, text: "", column: request.column, chat: chat.path });
        const card = find(await board.get(), id, project);
        const left = previous && previous.id !== id ? ` This chat left card ${previous.id} (${previous.title}).` : "";
        return { text: `This chat now works on card ${card.id}: ${card.title} (${COLUMN_LABELS[card.column]}).${left}`, card: card.id };
      }
      case "update": {
        const own = await mine();
        if (!own) throw bridgeError(409, "This chat has no card. Use kanban_claim first.");
        const edit = request.title !== undefined || request.tags !== undefined;
        if (!request.report && !request.column && !edit) throw bridgeError(400, "pass column, report, title or tags");
        if (edit) await board.apply({ type: "edit", id: own.id, title: request.title, tags: request.tags });
        if (request.report || request.column) await board.apply({ type: "report", id: own.id, text: request.report ?? "", column: request.column, chat: chat.path });
        const card = find(await board.get(), own.id, project);
        const tags = card.tags.length ? ` Tags: ${card.tags.join(", ")}.` : "";
        return { text: `Card ${card.id} (${card.title}) is in ${COLUMN_LABELS[card.column]}.${tags}${request.report ? " Report saved." : ""}`, card: card.id };
      }
      default:
        throw bridgeError(400, `unknown action ${String(request?.action)}`);
    }
  };
}

/** A card on the chat's project board. */
function find(board: Board, id: string, cwd: string): Card {
  const card = projectCards(board, cwd).find((other) => other.id === id);
  if (!card) throw bridgeError(404, `No card ${id} on this project's board. Use kanban_list to see the cards.`);
  return card;
}

function overview(board: Board, only: Column | undefined, cwd: string, own: Card | undefined): string {
  const cards = projectCards(board, cwd).filter((card) => !only || card.column === only);
  const head = `Kanban board of ${cwd}: ${cards.length} card${cards.length === 1 ? "" : "s"}. ${own ? `This chat works on card ${own.id}.` : "This chat has no card."}`;
  const sections = COLUMNS.filter((column) => !only || column === only).map((column) => {
    const inColumn = cards.filter((card) => card.column === column);
    const limit = column === "done" && !only ? SHOWN_DONE : SHOWN_PER_COLUMN;
    const lines = inColumn.slice(0, limit).map((card) => summary(card, own));
    if (inColumn.length > limit) lines.push(`- … ${inColumn.length - limit} more (kanban_list with column "${column}")`);
    return `## ${COLUMN_LABELS[column]} (${inColumn.length})${lines.length ? `\n${lines.join("\n")}` : ""}`;
  });
  return [head, ...sections].join("\n\n");
}

function summary(card: Card, own: Card | undefined): string {
  const marks = [card.id === own?.id ? "this chat's card" : "", card.chats.length ? `${card.chats.length} chat${card.chats.length === 1 ? "" : "s"}` : ""];
  const tags = card.tags.map((tag) => ` #${tag}`).join("");
  const latest = card.reports.findLast((report) => report.text)?.text || card.notes;
  const note = latest ? `\n  ${clip(latest.replace(/\s+/g, " "), 160)}` : "";
  return `- ${card.id} ${card.title}${tags}${marks.some(Boolean) ? `  (${marks.filter(Boolean).join(", ")})` : ""}${note}`;
}

function detail(card: Card, path: string): string {
  const lines = [
    `Card ${card.id}: ${card.title}`,
    `${COLUMN_LABELS[card.column]} · created ${stamp(card.createdAt)} · updated ${stamp(card.updatedAt)}`,
    `Chats: ${card.chats.length}${card.chats.some((ref) => ref.path === path) ? " (including this one)" : ""}`,
  ];
  if (card.tags.length) lines.push(`Tags: ${card.tags.join(", ")}`);
  if (card.notes) lines.push("", "Notes:", card.notes);
  if (card.reports.length) {
    lines.push("", "Reports, oldest first:");
    for (const report of card.reports) {
      const moved = report.column ? ` [moved to ${COLUMN_LABELS[report.column]}]` : "";
      lines.push(`- ${stamp(report.at)}${moved}${report.chat === path ? " (this chat)" : ""} ${report.text}`.trimEnd());
    }
  }
  return lines.join("\n");
}

const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
