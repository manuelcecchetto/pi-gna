// POST /kanban on the agent bridge: the kanban_* tools. The calling chat is the session behind the token; it sees
// its project's board (projectOf: a card's worktree counts as its project), and its cards are the ones its session
// file is attached to (any number). It may update any card of the board; without a card id, update means its card.
import {
  type Board,
  type Card,
  type Column,
  COLUMN_LABELS,
  COLUMNS,
  cardsOfChat,
  freshId,
  isColumn,
  projectCards,
  projectOf,
  type KanbanRequest,
  type KanbanResponse,
} from "../shared/board";
import { refLabel, refLine } from "../shared/github";
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

    switch (request?.action) {
      case "list": {
        const current = await board.get();
        const own = cardsOfChat(current, chat.path).filter((card) => card.cwd === project);
        if (request.card) return { text: detail(find(current, request.card, project), chat.path), card: own[0]?.id };
        return { text: overview(current, request.column, project, own), card: own[0]?.id };
      }
      case "claim": {
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
        const others = cardsOfChat(await board.get(), chat.path).filter((other) => other.id !== id && other.cwd === project);
        const also = others.length ? ` It also works on card${others.length === 1 ? "" : "s"} ${others.map((other) => other.id).join(", ")}.` : "";
        return { text: `This chat now works on card ${card.id}: ${card.title} (${COLUMN_LABELS[card.column]}).${also}`, card: card.id };
      }
      case "update": {
        const current = await board.get();
        const id = request.card ? find(current, request.card, project).id : ownCard(current, chat.path, project);
        const edit = request.title !== undefined || request.tags !== undefined;
        if (!request.report && !request.column && !edit && !request.leave) throw bridgeError(400, "pass column, report, title, tags or leave");
        if (edit) await board.apply({ type: "edit", id, title: request.title, tags: request.tags });
        if (request.report || request.column) await board.apply({ type: "report", id, text: request.report ?? "", column: request.column, chat: chat.path });
        if (request.leave) await board.apply({ type: "detach", id, path: chat.path });
        const card = find(await board.get(), id, project);
        const tags = card.tags.length ? ` Tags: ${card.tags.join(", ")}.` : "";
        const left = request.leave ? " This chat left it." : "";
        return { text: `Card ${card.id} (${card.title}) is in ${COLUMN_LABELS[card.column]}.${tags}${request.report ? " Report saved." : ""}${left}`, card: card.id };
      }
      default:
        throw bridgeError(400, `unknown action ${String(request?.action)}`);
    }
  };
}

/** The card an update without a card id means: the chat's only card on this board. */
function ownCard(board: Board, path: string, cwd: string): string {
  const own = cardsOfChat(board, path).filter((card) => card.cwd === cwd);
  if (own.length === 1) return own[0]!.id;
  if (!own.length) throw bridgeError(409, "This chat has no card. Pass card (an id from kanban_list), or use kanban_claim first.");
  throw bridgeError(409, `This chat works on cards ${own.map((card) => card.id).join(", ")}. Pass card to say which one.`);
}

/** A card on the chat's project board. */
function find(board: Board, id: string, cwd: string): Card {
  const card = projectCards(board, cwd).find((other) => other.id === id);
  if (!card) throw bridgeError(404, `No card ${id} on this project's board. Use kanban_list to see the cards.`);
  return card;
}

function overview(board: Board, only: Column | undefined, cwd: string, own: Card[]): string {
  const cards = projectCards(board, cwd).filter((card) => !only || card.column === only);
  const works = own.length ? `This chat works on card${own.length === 1 ? "" : "s"} ${own.map((card) => card.id).join(", ")}.` : "This chat has no card.";
  const head = `Kanban board of ${cwd}: ${cards.length} card${cards.length === 1 ? "" : "s"}. ${works}`;
  const sections = COLUMNS.filter((column) => !only || column === only).map((column) => {
    const inColumn = cards.filter((card) => card.column === column);
    const limit = column === "done" && !only ? SHOWN_DONE : SHOWN_PER_COLUMN;
    const lines = inColumn.slice(0, limit).map((card) => summary(card, own));
    if (inColumn.length > limit) lines.push(`- … ${inColumn.length - limit} more (kanban_list with column "${column}")`);
    return `## ${COLUMN_LABELS[column]} (${inColumn.length})${lines.length ? `\n${lines.join("\n")}` : ""}`;
  });
  return [head, ...sections].join("\n\n");
}

function summary(card: Card, own: Card[]): string {
  const marks = [
    own.includes(card) ? "this chat's card" : "",
    card.chats.length ? `${card.chats.length} chat${card.chats.length === 1 ? "" : "s"}` : "",
    ...card.github.map(refLabel),
  ];
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
  if (card.github.length) lines.push("GitHub:", ...card.github.map((ref) => `- ${refLine(ref)}`));
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
