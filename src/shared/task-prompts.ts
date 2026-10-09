// What the chats a card, a lament or a pull request start are told, and the names they get: written once, here, so
// the host (main) builds them for any client. Pure functions of the board, the laments and GitHub's items.
import { COLUMN_LABELS, type Card, LIMITS, projectCards, projectOf } from "./board";
import type { Board } from "./board";
import { type GithubItem, type GithubRepo, itemRef, refLabel, refLine, tokenVariable } from "./github";
import type { CardWorktree } from "./ipc";
import { type Lament, lamentSeverity, SEVERITY } from "./laments";

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

const TRIAGE = "Triage: ";
/** The name of a card's triage chat. Triage chats stay out of the sidebar: they are reached from their card. */
export const triageName = (card: Pick<Card, "title">): string => `${TRIAGE}${card.title}`;
export const isTriage = (name: string | undefined): boolean => name?.startsWith(TRIAGE) ?? false;



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

/**
 * A card task as a message to a chat that is already open (the card tab's default), instead of a new chat's first one.
 * That chat keeps its own folder: only a new chat gets the card's git worktree.
 */
export function inChatPrompt(card: Card, kind: "investigate" | "resolve" | "qa"): string {
  if (kind === "investigate") return investigatePrompt(card);
  const prompt = kind === "resolve" ? resolvePrompt(card) : qaPrompt(card);
  const note = hasWorktree(card) ? "\n\nEarlier chats on this card worked in a git worktree of the project: find it with `git worktree list` and the card's reports." : "";
  return `${prompt.replace("This chat is attached to the card.", "You work here, in this chat's folder, and this chat is attached to the card.")}${note}`;
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

/** Reports a Fix chat reads: how the lament was filed and the latest evidence, each whole. */
const BRIEF_REPORTS = 3;

/** The lament as a chat sees it. */
export function lamentBlock(lament: Lament): string {
  const severity = SEVERITY[lamentSeverity(lament)];
  const lines = [`Lament ${lament.id}: ${lament.title}`, `Severity: ${severity.emoji} ${severity.label} (${severity.about})`];
  if (lament.reports.length > 1) lines.push(`Hit ${lament.reports.length} times`);
  const [first, ...rest] = lament.reports;
  const latest = rest.slice(1 - BRIEF_REPORTS);
  const skipped = rest.length - latest.length;
  lines.push("", `Reports, oldest first${skipped ? ` (${skipped} in between left out)` : ""}:`);
  for (const report of [first, ...latest]) {
    if (report) lines.push("", `--- ${SEVERITY[report.severity].label}, ${new Date(report.at).toISOString().slice(0, 16).replace("T", " ")}Z`, report.text);
  }
  return `<lament>\n${lines.join("\n")}\n</lament>`;
}


/** `worktree`: where the chat works (null: the project is not in git, so it works in the project folder). */
export function fixPrompt(lament: Lament, worktree: CardWorktree | null = null): string {
  return [
    "Fix the gap this lament from the project's Lamenting board describes, so the next agent does not hit it: make the change, verify it, and tell me what you did.",
    lamentBlock(lament),
    [
      "An agent filed it when a tool or capability it needed was missing, unavailable, hard to find or failing, and worked around it.",
      "Find the cause: the project's own code, scripts and docs, its .pi folder (extensions, skills, AGENTS.md), or the tool the agent used.",
      "Fix the cause rather than adding another workaround, then verify the fix by doing what the lament wanted to do.",
      "Where the fix belongs outside this project (pi's global setup in ~/.pi/agent, another repository, an app or a permission), do not change it there: tell me what to change and why.",
    ].join(" "),
    ...(worktree ? [worktreeNote(lament.cwd, worktree, "lament")] : []),
    "I mark the lament resolved once your fix is in, so do not file it again while you work on it. End with what changed, how you verified it and what is left for me.",
  ].join("\n\n");
}

/** A review chat's name: "Review PR #12: Fix the login". */
export const reviewName = (item: GithubItem): string => `Review ${refLabel(item)}: ${item.title.trim()}`.slice(0, LIMITS.title);

/**
 * The first message of a chat that reviews a pull request with pi-gna's pr-review skill (resources/skills/pr-review),
 * as `login`, the gh account pi-gna reads the repository as, which may not be gh's active one.
 */
export function reviewPrompt(repo: GithubRepo, item: GithubItem, login?: string): string {
  const facts = [
    item.head && `Branch ${item.head} into ${item.base ?? "the default branch"}`,
    `by ${item.author}`,
    item.draft && item.state === "open" ? "a draft" : item.state !== "open" && item.state,
  ].filter(Boolean);
  return [
    "Review this pull request with the pr-review skill: read it and the code it changes, check it, and tell me what you find.",
    `${refLine(itemRef(repo, { ...item, title: item.title.trim() }))}\n${facts.join(", ")}.`,
    ...(login
      ? [
          `pi-gna reads ${repo.repo} as the gh account ${login}. If gh cannot see the repository as its active account, run gh as ${login} without switching accounts: ${tokenVariable(repo.host)}="$(gh auth token --hostname ${repo.host} --user ${login})" gh …`,
        ]
      : []),
    "Leave my checkout as it is, and keep the review in this chat: do not comment, approve or request changes on GitHub unless I ask.",
  ].join("\n\n");
}

