// The Kanban page's view of the board: one project's columns, what a card's chats are doing, and what the chats
// a card starts are told (src/shared/task-prompts.ts).
import { type Board, COLUMNS, type Card, type ChatRef, type Column, projectCards } from "../../../shared/board";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { markdownText } from "../../../shared/markdown-text";
import { splitAttachments } from "../../../shared/task-prompts";
import { type Attention, strongestLevel } from "../../../shared/session-state";
import type { OpenChat } from "./projects";

export function boardColumns(board: Board, cwd: string): Record<Column, Card[]> {
  const columns = Object.fromEntries(COLUMNS.map((column) => [column, [] as Card[]])) as Record<Column, Card[]>;
  for (const card of projectCards(board, cwd)) columns[card.column].push(card);
  return columns;
}

/**
 * What the card's chats need from you, strongest first (running, waiting, failed, unread), from the open chats as the
 * lists show them (useOpenChats): streaming into a chat does not change those, so the board does not render for it.
 */
export function cardAttention(card: Card, chats: OpenChat[]): Attention | undefined {
  const paths = new Set(card.chats.map((chat) => chat.path));
  return strongestLevel(chats.flatMap((chat) => (chat.sessionPath !== undefined && paths.has(chat.sessionPath) ? [chat.attention] : [])));
}

/** The line under a card's title: its latest report, else its notes (without their attachments). */
export function cardSnippet(card: Card): string {
  const latest = markdownText(card.reports.findLast((report) => report.text)?.text || splitAttachments(card.notes).text);
  // A short description is all in the title of its new card.
  return latest === card.title ? "" : latest;
}

/** Projects the board can switch to: the sidebar's, then others that have cards; `current` always. */
export function boardProjects(board: Board, projects: ProjectGroup[], current: string): { cwd: string; open: number }[] {
  const cwds = [...new Set([current, ...projects.map((project) => project.cwd), ...board.cards.map((card) => card.cwd)])];
  const open = (cwd: string) => board.cards.filter((card) => card.cwd === cwd && card.column !== "done").length;
  return cwds.map((cwd) => ({ cwd, open: open(cwd) }));
}

/** The indexed session behind a card's chat, for its title and to open it. */
export function findSummary(projects: ProjectGroup[], path: string): SessionSummary | undefined {
  for (const project of projects) {
    const found = project.sessions.find((session) => session.path === path);
    if (found) return found;
  }
  return undefined;
}

/** What opens a card's chat: its indexed session, else what the card knows about it. */
export function chatSummary(projects: ProjectGroup[], ref: ChatRef): SessionSummary {
  return findSummary(projects, ref.path) ?? { path: ref.path, id: "", cwd: ref.cwd, title: ref.label ?? "Chat", named: Boolean(ref.label), createdAt: ref.at, modifiedAt: ref.at };
}

/** A chat's title: the open chat's, else the session index's, else its label on the card. */
export function chatTitle(path: string, card: Card, projects: ProjectGroup[], chats: OpenChat[]): string {
  const open = chats.find((chat) => chat.sessionPath === path);
  if (open) return open.title;
  return findSummary(projects, path)?.title ?? card.chats.find((ref) => ref.path === path)?.label ?? "a chat";
}

