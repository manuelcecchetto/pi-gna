// The Kanban boards: task cards in four columns, one board per project (cards carry their project's cwd). Chats
// of the project attach to cards (a chat can work on several), and agents move their cards and report on them
// through the kanban_* tools. Main owns the cards and applies every change through applyOp, from the renderer
// (drag, menus, dialog) and from agents (the bridge) alike.

export const COLUMNS = ["todo", "in_progress", "in_review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done" };

export const LIMITS = { title: 300, notes: 20_000, report: 4_000, label: 200, reports: 50, tag: 24, tags: 6, github: 20 } as const;

/** A pi session attached to a card, by its session file. */
export interface ChatRef {
  path: string;
  cwd: string;
  /** Title when attached, for chats that are neither open nor indexed. */
  label?: string;
  at: number;
}

/** A progress note, usually from the agent working on the card. */
export interface Report {
  at: number;
  text: string;
  /** The card moved to this column with the report. */
  column?: Column;
  /** Session file of the chat that wrote it. */
  chat?: string;
}

/**
 * A GitHub issue or pull request a card is about. Not the gh account that found it: pi-gna picks the account per
 * project whenever it asks GitHub, so the link stays valid when that choice changes.
 */
export interface GithubRef {
  kind: "issue" | "pr";
  /** github.com, or a GitHub Enterprise host. */
  host: string;
  /** owner/name. */
  repo: string;
  number: number;
  url: string;
  /** Its title when it was linked. */
  title: string;
}

export interface Card {
  id: string;
  title: string;
  notes: string;
  /** Lowercase, dash-joined words (see normalizeTags), at most LIMITS.tags. */
  tags: string[];
  /** The project whose board the card is on; its chats run here. */
  cwd: string;
  column: Column;
  /** Issues and pull requests it is about, at most LIMITS.github. */
  github: GithubRef[];
  chats: ChatRef[];
  /** Oldest first, the last LIMITS.reports. */
  reports: Report[];
  createdAt: number;
  updatedAt: number;
}

/** Every project's cards, in display order: a project's column shows its cards in array order. */
export interface Board {
  version: 1;
  cards: Card[];
}

/**
 * Where a card lands in its column: an id puts it just before that card, null at the bottom, and no value at
 * the top (where a card that just moved is easiest to see).
 */
type Placement = { before?: string | null };

export type BoardOp =
  | ({ type: "add"; id?: string; title: string; notes?: string; tags?: string[]; cwd: string; column?: Column; github?: GithubRef[] } & Placement)
  | { type: "edit"; id: string; title?: string; notes?: string; tags?: string[] }
  | ({ type: "move"; id: string; column: Column } & Placement)
  | { type: "remove"; id: string }
  /** Attach a chat of the card's project (projectOf); it stays on its other cards. */
  | { type: "attach"; id: string; chat: { path: string; cwd: string; label?: string } }
  | { type: "detach"; id: string; path: string }
  | { type: "report"; id: string; text: string; column?: Column; chat?: string }
  /** Link an issue or pull request (again: a link it has gets the new title). */
  | { type: "link"; id: string; github: GithubRef }
  | { type: "unlink"; id: string; github: Pick<GithubRef, "host" | "repo" | "number"> };

/**
 * POST /kanban on the agent bridge (resources/kanban-extension.ts). The calling chat is known from its token, and
 * only its project's board is visible.
 */
export interface KanbanRequest {
  action: "list" | "claim" | "update";
  /** list: only this column. claim, update: move the card here. */
  column?: Column;
  /** list: show this card in full. claim: the card to take. update: the card to change (the chat's card when it has one). */
  card?: string;
  /** claim: create a card in this chat's project instead. update: rename the card. */
  title?: string;
  notes?: string;
  /** claim (a new card), update: replace the card's tags. */
  tags?: string[];
  /** update: a progress note for the user. */
  report?: string;
  /** update: take this chat off the card. */
  leave?: boolean;
}

export interface KanbanResponse {
  text: string;
  /** The card the call took or changed, or for list the chat's latest card. */
  card?: string;
}

export class BoardError extends Error {}

export const emptyBoard = (): Board => ({ version: 1, cards: [] });

const ID = /^[a-z0-9]{6}$/;
export const isCardId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** The card a chat link points at: `card:<id>` or the bare id an agent writes (`[card q6ip3j](q6ip3j)`). */
export function cardLinkId(href: string): string | undefined {
  const text = href.trim().replace(/^card:/i, "").toLowerCase();
  return isCardId(text) ? text : undefined;
}

const LINK_LABEL_MAX = 80;

/** A chat card link reads as the card's title (cut at 80 characters); the tooltip has the full title, column and id. */
export function cardLinkLabel(card: Pick<Card, "id" | "title" | "column">): { text: string; tip: string } {
  const title = card.title.trim() || card.id;
  const text = title.length > LINK_LABEL_MAX ? `${title.slice(0, LINK_LABEL_MAX - 1).trimEnd()}…` : title;
  return { text, tip: `${title} · ${COLUMN_LABELS[card.column]} · ${card.id}` };
}

const WORKTREES = [".pi-gna", "worktrees"];
// A Windows path: a drive (C:\x, C:/x) or a UNC share (\\server\share).
const DRIVE = /^([A-Za-z]):/;
const UNC = /^[\\/]{2}[^\\/]/;

/**
 * Where a card's Resolve chat works: the project's folder in the card's git worktree, which mirrors the project's
 * path under ~/.pi-gna/worktrees/<card>. Outside the project, so pi does not load its AGENTS.md twice and its test
 * runner does not find the copy. On Windows the project's root becomes a folder: C:\x mirrors as <card>\C\x and
 * \\server\share as <card>\UNC\server\share.
 */
export function worktreeCwd(home: string, card: string, project: string): string {
  const windows = DRIVE.test(project) || UNC.test(project);
  const sep = windows ? "\\" : "/";
  const mirror = DRIVE.test(project) ? project.replace(DRIVE, "$1") : UNC.test(project) ? `UNC${project.slice(1)}` : project.replace(/^\/+/, "");
  return [home.replace(/[\\/]+$/, ""), ...WORKTREES, card, mirror].join(sep);
}

const IN_WORKTREE = /[\\/]\.pi-gna[\\/]worktrees[\\/]([a-z0-9]{6})([\\/].*)$/;

/** The project a chat belongs to: its cwd, or for a card's worktree (worktreeCwd) the project it is a copy of. */
export function projectOf(cwd: string): string {
  const match = IN_WORKTREE.exec(cwd);
  const rest = match?.[2];
  if (!rest) return cwd;
  if (rest[0] === "/") return rest;
  // Windows: the first folder is the drive letter, or UNC for a network share.
  const drive = /^\\([A-Za-z])(?=$|[\\/])/.exec(rest);
  if (drive) return `${drive[1]}:${rest.slice(2) || "\\"}`;
  if (/^\\UNC[\\/]/.test(rest)) return `${rest[4]}${rest.slice(4)}`;
  return cwd;
}

/** The card whose worktree (worktreeCwd) `cwd` lies in, or undefined outside one. */
export function cardOfWorktree(cwd: string): string | undefined {
  return IN_WORKTREE.exec(cwd)?.[1];
}

/** Where work on `path` (a plan, a file) runs for `project`: the project's folder in the worktree `path` lies in, else the project. */
export function checkoutOf(path: string, project: string): string {
  const match = IN_WORKTREE.exec(path);
  const card = match?.[1];
  if (!match || !card) return project;
  const folder = worktreeCwd(path.slice(0, match.index), card, project);
  return path.startsWith(folder) && /^[\\/]/.test(path.slice(folder.length)) ? folder : project;
}

/** A short id that is easy for the model to repeat. */
export function freshId(board: Board, random: () => number = Math.random): string {
  const taken = new Set(board.cards.map((card) => card.id));
  for (;;) {
    const id = Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, "0");
    if (!taken.has(id)) return id;
  }
}

export const isColumn = (value: unknown): value is Column => COLUMNS.includes(value as Column);

/** Apply one change. Ops come from the renderer and from agents, so every field is checked. Throws BoardError. */
export function applyOp(board: Board, op: BoardOp, now: number): Board {
  switch (op?.type) {
    case "add": {
      const id = op.id ?? freshId(board);
      if (!ID.test(id) || board.cards.some((card) => card.id === id)) throw new BoardError(`invalid card id ${id}`);
      const column = op.column ?? "todo";
      if (!isColumn(column)) throw new BoardError(`unknown column ${String(column)}`);
      const card: Card = {
        id,
        title: title(op.title),
        notes: text(op.notes ?? "", "notes", LIMITS.notes),
        tags: normalizeTags(op.tags ?? []),
        cwd: path(op.cwd, "cwd"),
        column,
        github: githubRefs(op.github ?? []),
        chats: [],
        reports: [],
        createdAt: now,
        updatedAt: now,
      };
      return { ...board, cards: place(board.cards, card, op.before) };
    }
    case "edit": {
      const card = find(board, op.id);
      return update(board, {
        ...card,
        title: op.title === undefined ? card.title : title(op.title),
        notes: op.notes === undefined ? card.notes : text(op.notes, "notes", LIMITS.notes),
        tags: op.tags === undefined ? card.tags : normalizeTags(op.tags),
        updatedAt: now,
      });
    }
    case "move": {
      const card = find(board, op.id);
      if (!isColumn(op.column)) throw new BoardError(`unknown column ${String(op.column)}`);
      if (op.before === op.id) return board;
      const rest = board.cards.filter((other) => other !== card);
      return { ...board, cards: place(rest, { ...card, column: op.column, updatedAt: now }, op.before) };
    }
    case "remove":
      find(board, op.id);
      return { ...board, cards: board.cards.filter((card) => card.id !== op.id) };
    case "attach": {
      const card = find(board, op.id);
      const chat: ChatRef = { path: path(op.chat?.path, "chat path"), cwd: path(op.chat?.cwd, "chat cwd"), at: now };
      if (projectOf(chat.cwd) !== card.cwd) throw new BoardError(`card ${card.id} is on the board of ${card.cwd}, not of this chat's project`);
      if (op.chat.label) chat.label = text(op.chat.label, "label", LIMITS.label).replace(/\s+/g, " ").trim();
      if (card.chats.some((ref) => ref.path === chat.path)) return board;
      return update(board, { ...card, chats: [...card.chats, chat], updatedAt: now });
    }
    case "detach": {
      const card = find(board, op.id);
      if (!card.chats.some((ref) => ref.path === op.path)) return board;
      return update(board, { ...card, chats: card.chats.filter((ref) => ref.path !== op.path), updatedAt: now });
    }
    case "report": {
      const card = find(board, op.id);
      if (op.column !== undefined && !isColumn(op.column)) throw new BoardError(`unknown column ${String(op.column)}`);
      const report: Report = { at: now, text: text(op.text, "report", LIMITS.report).trim() };
      if (op.column && op.column !== card.column) report.column = op.column;
      if (op.chat) report.chat = path(op.chat, "chat path");
      if (!report.text && !report.column) return board;
      const next: Card = { ...card, reports: [...card.reports, report].slice(-LIMITS.reports), updatedAt: now };
      if (!report.column) return update(board, next);
      return { ...board, cards: place(board.cards.filter((other) => other !== card), { ...next, column: report.column }, undefined) };
    }
    case "link": {
      const card = find(board, op.id);
      const ref = githubRef(op.github);
      const index = card.github.findIndex((other) => githubKey(other) === githubKey(ref));
      if (index >= 0 && JSON.stringify(card.github[index]) === JSON.stringify(ref)) return board;
      if (index < 0 && card.github.length >= LIMITS.github) throw new BoardError(`card ${card.id} already has ${LIMITS.github} GitHub links`);
      const github = index < 0 ? [...card.github, ref] : card.github.map((other, at) => (at === index ? ref : other));
      return update(board, { ...card, github, updatedAt: now });
    }
    case "unlink": {
      const card = find(board, op.id);
      const key = githubKey(op.github ?? { host: "", repo: "", number: 0 });
      if (!card.github.some((other) => githubKey(other) === key)) return board;
      return update(board, { ...card, github: card.github.filter((other) => githubKey(other) !== key), updatedAt: now });
    }
    default:
      throw new BoardError(`unknown board op ${String((op as { type?: unknown })?.type)}`);
  }
}

/**
 * Whether an edit would overwrite text someone else changed: the op replaces a field whose value in `base` (the board
 * its author saw; undefined when too old to know) is not the one now. Only free-text edits can conflict; every other
 * op is last-writer-wins.
 */
export function boardConflict(base: Board | undefined, current: Board, op: BoardOp): boolean {
  if (op?.type !== "edit") return false;
  const now = current.cards.find((card) => card.id === op.id);
  if (!now) return false; // applyOp reports the missing card
  const was = base?.cards.find((card) => card.id === op.id);
  if (!was) return base === undefined; // too old to tell; a card the editor never saw is not its to conflict on
  return (
    (op.title !== undefined && was.title !== now.title) ||
    (op.notes !== undefined && was.notes !== now.notes) ||
    (op.tags !== undefined && JSON.stringify(was.tags) !== JSON.stringify(now.tags))
  );
}

/** Tags spelled one way on every card: "#UI Bug" and "ui-bug" are the same tag. Throws BoardError. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BoardError("tags must be a list");
  const tags = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== "string") throw new BoardError("a tag must be text");
    const clean = tag.trim().replace(/^#+/, "").trim().replace(/\s+/g, "-").toLowerCase();
    if (clean.length > LIMITS.tag) throw new BoardError(`tag ${clean} is too long (at most ${LIMITS.tag} characters)`);
    if (clean) tags.add(clean);
  }
  if (tags.size > LIMITS.tags) throw new BoardError(`too many tags (${tags.size}, at most ${LIMITS.tags})`);
  return [...tags];
}

/** Identifies an issue or pull request across cards and repositories: "github.com/owner/name#12", lowercase. */
export const githubKey = (ref: Pick<GithubRef, "host" | "repo" | "number">): string => `${ref.host}/${ref.repo}#${ref.number}`.toLowerCase();

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** A GitHub link from the renderer or an agent, checked: its url must be on its host, so it is safe to open. Throws BoardError. */
export function githubRef(value: unknown): GithubRef {
  const ref = value as Partial<GithubRef> | null;
  if (ref?.kind !== "issue" && ref?.kind !== "pr") throw new BoardError("a GitHub link is to an issue or a pr");
  if (typeof ref.host !== "string" || !HOST.test(ref.host)) throw new BoardError(`invalid GitHub host ${String(ref.host)}`);
  if (typeof ref.repo !== "string" || !REPO.test(ref.repo)) throw new BoardError(`invalid GitHub repository ${String(ref.repo)}; use owner/name`);
  if (typeof ref.number !== "number" || !Number.isSafeInteger(ref.number) || ref.number < 1) throw new BoardError(`invalid issue or pull request number ${String(ref.number)}`);
  const host = ref.host.toLowerCase();
  if (typeof ref.url !== "string" || !ref.url.toLowerCase().startsWith(`https://${host}/`) || ref.url.length > 2048) throw new BoardError(`a GitHub link's url must be on https://${host}/`);
  const name = text(ref.title ?? "", "GitHub title", LIMITS.title).replace(/\s+/g, " ").trim();
  return { kind: ref.kind, host, repo: ref.repo, number: ref.number, url: ref.url, title: name };
}

function githubRefs(value: unknown): GithubRef[] {
  if (!Array.isArray(value)) throw new BoardError("github must be a list of links");
  const refs = new Map(value.map((item) => githubRef(item)).map((ref) => [githubKey(ref), ref]));
  if (refs.size > LIMITS.github) throw new BoardError(`too many GitHub links (${refs.size}, at most ${LIMITS.github})`);
  return [...refs.values()];
}

const isGithubRef = (value: unknown): boolean => {
  try {
    githubRef(value);
    return true;
  } catch {
    return false;
  }
};

export const projectCards = (board: Board, cwd: string) => board.cards.filter((card) => card.cwd === cwd);

/** The cards a chat is attached to, the one it joined last first. */
export function cardsOfChat(board: Board, path: string): Card[] {
  const joined = (card: Card) => card.chats.find((ref) => ref.path === path)?.at || 0;
  return board.cards.filter((card) => card.chats.some((ref) => ref.path === path)).sort((a, b) => joined(b) - joined(a));
}

/** The card a chat joined last, the one its header and menus show. */
export const cardOfChat = (board: Board, path: string): Card | undefined => cardsOfChat(board, path)[0];

/** Read a board file, keeping the cards that are well formed. */
export function parseBoard(value: unknown): { board: Board; dropped: number } {
  const cards = (value as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(cards)) throw new BoardError("not a board");
  // Boards from before tags or GitHub links have cards without them.
  const valid = cards.filter(isCard).map((card) => ({ ...card, tags: card.tags ?? [], github: card.github ?? [] }));
  return { board: { version: 1, cards: valid }, dropped: cards.length - valid.length };
}

function isCard(value: unknown): value is Card {
  const card = value as Partial<Card> | null;
  return (
    typeof card?.id === "string" &&
    typeof card.title === "string" &&
    typeof card.notes === "string" &&
    (card.tags === undefined || (Array.isArray(card.tags) && card.tags.every((tag) => typeof tag === "string"))) &&
    (card.github === undefined || (Array.isArray(card.github) && card.github.every(isGithubRef))) &&
    typeof card.cwd === "string" &&
    isColumn(card.column) &&
    Array.isArray(card.chats) &&
    card.chats.every((chat) => typeof chat?.path === "string" && typeof chat.cwd === "string") &&
    Array.isArray(card.reports) &&
    card.reports.every((report) => typeof report?.text === "string" && typeof report.at === "number") &&
    typeof card.createdAt === "number" &&
    typeof card.updatedAt === "number"
  );
}

function find(board: Board, id: string): Card {
  const card = board.cards.find((other) => other.id === id);
  if (!card) throw new BoardError(`no card ${String(id)}`);
  return card;
}

function update(board: Board, card: Card): Board {
  return { ...board, cards: board.cards.map((other) => (other.id === card.id ? card : other)) };
}

function place(cards: Card[], card: Card, before: string | null | undefined): Card[] {
  const inColumn = (other: Card) => other.column === card.column;
  let index = -1;
  if (before) index = cards.findIndex((other) => other.id === before && inColumn(other));
  else if (before === undefined) index = cards.findIndex(inColumn);
  // The bottom (null, or a card that is no longer in that column): after the column's last card.
  if (index < 0) {
    const last = cards.findLastIndex(inColumn);
    index = last < 0 ? cards.length : last + 1;
  }
  return [...cards.slice(0, index), card, ...cards.slice(index)];
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new BoardError(`${field} must be text`);
  if (value.length > max) throw new BoardError(`${field} is too long (${value.length} characters, at most ${max})`);
  return value;
}

function title(value: unknown): string {
  const clean = text(value, "title", LIMITS.title).replace(/\s+/g, " ").trim();
  if (!clean) throw new BoardError("a card needs a title");
  return clean;
}

function path(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096) throw new BoardError(`${field} must be an absolute path`);
  return value;
}
