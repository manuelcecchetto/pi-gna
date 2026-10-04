// The Kanban page's view of the board: one project's columns, what a card's chats are doing, and what the chats
// a card starts are told.
import { type Board, COLUMN_LABELS, COLUMNS, type Card, type ChatRef, type Column, projectCards, projectOf } from "../../../shared/board";
import { refLine } from "../../../shared/github";
import type { CardWorktree, ProjectGroup, SessionSummary } from "../../../shared/ipc";
import type { Model, ThinkingLevel } from "../../../shared/protocol";
import { type Attention, type SessionState, strongestAttention } from "./session";

export function boardColumns(board: Board, cwd: string): Record<Column, Card[]> {
  const columns = Object.fromEntries(COLUMNS.map((column) => [column, [] as Card[]])) as Record<Column, Card[]>;
  for (const card of projectCards(board, cwd)) columns[card.column].push(card);
  return columns;
}

/** The card's chats that are open in pi-gna. */
export function liveChats(card: Card, sessions: SessionState[]): SessionState[] {
  const paths = new Set(card.chats.map((chat) => chat.path));
  return sessions.filter((session) => session.sessionPath !== undefined && paths.has(session.sessionPath));
}

/** What the card's chats need from you, strongest first (running, waiting, failed, unread). */
export function cardAttention(card: Card, sessions: SessionState[]): Attention | undefined {
  return strongestAttention(liveChats(card, sessions));
}

/** The line under a card's title: its latest report, else its notes (without their attachments). */
export function cardSnippet(card: Card): string {
  const latest = (card.reports.findLast((report) => report.text)?.text || splitAttachments(card.notes).text).replace(/\s+/g, " ").trim();
  // A short description is all in the title of its new card.
  return latest === card.title ? "" : latest;
}

/** The project's tags, most used first, for new cards to reuse. */
export function boardTags(board: Board, cwd: string): string[] {
  const counts = new Map<string, number>();
  for (const card of projectCards(board, cwd)) for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([tag]) => tag);
}

const DRAFT_TITLE = 80;

/** A new card's title until its triage names it: the start of your description, cut at a word. */
export function draftTitle(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (text.length <= DRAFT_TITLE) return text;
  const cut = text.slice(0, DRAFT_TITLE - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > DRAFT_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const ATTACHMENTS = "Attachments:";

/**
 * A new card's notes: your description, then what you attached (pasted screenshots are saved first, CardImages),
 * one path per line. Every chat on the card gets the notes, and pi's read tool shows an image file as an image.
 */
export function cardNotes(description: string, paths: string[]): string {
  const text = description.trim();
  if (!paths.length) return text;
  return [text, [ATTACHMENTS, ...paths.map((path) => `- ${path}`)].join("\n")].filter(Boolean).join("\n\n");
}

/** Notes without their attachment list (cardNotes), and the paths on it; lines after the list stay in the text. */
export function splitAttachments(notes: string): { text: string; paths: string[] } {
  const lines = notes.split("\n");
  const start = lines.lastIndexOf(ATTACHMENTS);
  const paths: string[] = [];
  let end = start + 1;
  for (; start >= 0 && end < lines.length; end++) {
    const path = lines[end]?.match(/^- (\/.*\S)\s*$/)?.[1];
    if (!path) break;
    paths.push(path);
  }
  if (!paths.length) return { text: notes, paths };
  const text = [lines.slice(0, start), lines.slice(end)].map((part) => part.join("\n").trim()).filter(Boolean).join("\n\n");
  return { text, paths };
}

/** The model a chat started for a card runs on, for that chat only. */
export interface TaskModel {
  id: string;
  thinking: ThinkingLevel;
}

/** Names, tags and briefly investigates every card you add: quick and cheap, since it runs for each one. */
export const TRIAGE_MODEL: TaskModel = { id: "claude-sonnet-5-5", thinking: "low" };

const TRIAGE = "Triage: ";
/** The name of a card's triage chat. Triage chats stay out of the sidebar: they are reached from their card. */
export const triageName = (card: Pick<Card, "title">): string => `${TRIAGE}${card.title}`;
export const isTriage = (name: string | undefined): boolean => name?.startsWith(TRIAGE) ?? false;

/** A model by id, from the chat's own provider when it has it (several providers serve the same model). */
export function pickModel(models: Model[], id: string, provider: string | undefined): Model | undefined {
  return models.find((model) => model.id === id && model.provider === provider) ?? models.find((model) => model.id === id);
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
export function chatTitle(path: string, card: Card, projects: ProjectGroup[], live: SessionState[], titleOf: (session: SessionState) => string): string {
  const open = live.find((session) => session.sessionPath === path);
  if (open) return titleOf(open);
  return findSummary(projects, path)?.title ?? card.chats.find((ref) => ref.path === path)?.label ?? "a chat";
}

const RECENT_REPORTS = 5;
/** Per report in a brief; a composer full of an old investigation is hard to write under. */
const REPORT_CHARS = 600;

/** The card as a chat sees it, in a block pi-gna leaves out of chat titles. */
export function cardBlock(card: Card): string {
  const lines = [`Card ${card.id}: ${card.title}`, `Column: ${COLUMN_LABELS[card.column]}`];
  if (card.tags.length) lines.push(`Tags: ${card.tags.join(", ")}`);
  if (card.github.length) lines.push("GitHub:", ...card.github.map((ref) => `- ${refLine(ref)}`));
  if (card.notes.trim()) lines.push("", "Notes:", card.notes.trim());
  const reports = card.reports.slice(-RECENT_REPORTS);
  if (reports.length) {
    const older = card.reports.length - reports.length;
    lines.push("", `Latest reports, oldest first${older ? ` (${older} older: kanban_list with card ${card.id})` : ""}:`);
    for (const report of reports) {
      const text = report.text.length > REPORT_CHARS ? `${report.text.slice(0, REPORT_CHARS).trimEnd()}… (the rest: kanban_list with card ${card.id})` : report.text;
      lines.push(`- ${report.column ? `[moved to ${COLUMN_LABELS[report.column]}] ` : ""}${text}`.trimEnd());
    }
  }
  return `<kanban-card>\n${lines.join("\n")}\n</kanban-card>`;
}

export function investigatePrompt(card: Card): string {
  return [
    `Investigate this card from the project's Kanban board. Do not change any files: work out what is going on and what it would take, then tell me what you found and how you would resolve it.`,
    cardBlock(card),
    "This chat is attached to the card. When you are done, add your findings as a short report with kanban_update and leave the card in its column.",
  ].join("\n\n");
}

/** Sent in the background when you add a card: a quick, read-only first pass that names and tags it. */
export function triagePrompt(card: Card, tags: string[]): string {
  return [
    "Triage this new card from the project's Kanban board. I described the task in one go: the notes are my words, the title is only their start.",
    cardBlock(card),
    [
      ...(splitAttachments(card.notes).paths.length ? ["Read the files under Attachments in the notes first: screenshots show as images."] : []),
      "Take a quick, read-only look: find the code involved and what the change would take. Do not change files or run builds; this is a first pass, not the work.",
      "Then call kanban_update once, without a column, with:",
      `- title: what to do, specific and at most ${DRAFT_TITLE} characters ("Fix …", "Add …")`,
      `- tags: one to three short lowercase topics${tags.length ? `, reusing the board's where they fit: ${tags.join(", ")}` : ""}`,
      "- report: a few lines for whoever picks the card up: the files and code involved, the likely cause or approach, open questions",
    ].join("\n"),
  ].join("\n\n");
}

/** `worktree`: where the chat works (null: the project is not in git, so it works in the project folder). */
export function resolvePrompt(card: Card, worktree: CardWorktree | null = null): string {
  return [
    "Resolve this card from the project's Kanban board: make the change, verify it, and tell me what you did.",
    cardBlock(card),
    ...(worktree ? [worktreeNote(card.cwd, worktree)] : []),
    "This chat is attached to the card. Move it to in_progress with kanban_update when you start; when you are done, move it to in_review with a short report of what changed and how you verified it.",
  ].join("\n\n");
}

const WORKTREE_FILES = "The worktree has the committed files only, not ignored ones such as installed dependencies, .env files and builds: set up what you need in it.";

/** Where a chat that changes `project` works (`task`: what it was started from, a card or a lament). */
export function worktreeNote(project: string, worktree: CardWorktree, task = "card"): string {
  return [
    `You work in a git worktree of the project, on branch ${worktree.branch}: your working directory, ${worktree.cwd}, is the project's folder in it.`,
    worktree.created ? "" : `The worktree and branch are from an earlier chat on this ${task}: build on what is there.`,
    WORKTREE_FILES,
    worktree.dirty ? "The checkout has uncommitted changes, which are not in the worktree either." : "",
    `When the change is verified, commit it on the branch and name the branch in your report. Do not push or merge, and leave the checkout at ${project} as it is.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A chat on the card worked in its git worktree (a Resolve chat), so that is where the card's change is. */
export function hasWorktree(card: Card): boolean {
  return card.chats.some((chat) => projectOf(chat.cwd) !== chat.cwd);
}

/**
 * Checks a card in review where its change is: `worktree`, the card's, or null for the project folder (the card was
 * resolved there, or the project is not in git). The chat reports; it does not fix what it finds.
 */
export function qaPrompt(card: Card, worktree: CardWorktree | null = null): string {
  return [
    "QA this card from the project's Kanban board: its change is in review. Check that it does what the card asks and breaks nothing else, then tell me what you found.",
    cardBlock(card),
    worktree
      ? [
          `The change is on branch ${worktree.branch}, in a git worktree of the project: your working directory, ${worktree.cwd}, is the project's folder in it.`,
          "Review the commits the branch adds since it left the checkout's branch, and anything left uncommitted in it.",
          WORKTREE_FILES,
          `Do not commit, push or merge, and leave the checkout at ${card.cwd} as it is.`,
        ].join(" ")
      : "The change was made in the project folder: find it from the card's reports and, in git, the uncommitted changes and latest commits.",
    [
      "Review the diff against the card and its latest report, run the project's tests and checks, and try the change the way a user would where you can.",
      "Do not fix what you find: changing the code is a Resolve chat's job, and the change in review stays the one you checked. Installing dependencies and running builds to test it is fine.",
    ].join(" "),
    "This chat is attached to the card. When you are done, report your verdict and findings with kanban_update: leave the card in in_review if it passes, or move it to in_progress with what is wrong if it does not.",
  ].join("\n\n");
}
