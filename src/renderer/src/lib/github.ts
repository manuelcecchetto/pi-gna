// The GitHub page's view of the board: which cards link an issue or pull request, which cards one can be linked to,
// and the card a new one becomes.
import { type Board, type BoardOp, type Card, githubKey, type GithubRef, LIMITS } from "../../../shared/board";
import { type GithubItem, type GithubRepo, itemRef, refLabel } from "../../../shared/github";
import type { ProjectGroup } from "../../../shared/ipc";

/** Projects the GitHub page can switch to: `current`, then the sidebar's. Nothing is counted: only gh knows. */
export function githubProjects(projects: ProjectGroup[], current: string): { cwd: string; open: number }[] {
  return [...new Set([current, ...projects.map((project) => project.cwd)])].map((cwd) => ({ cwd, open: 0 }));
}

/** The cards that link each issue or pull request, by githubKey, from every project (worktrees share a repository). */
export function linkedCards(board: Board): Map<string, Card[]> {
  const linked = new Map<string, Card[]>();
  for (const card of board.cards) {
    for (const ref of card.github) linked.set(githubKey(ref), [...(linked.get(githubKey(ref)) ?? []), card]);
  }
  return linked;
}

/** At most this many cards in the "Link to card" menu. */
export const LINKABLE = 12;

/** The project's cards an issue or pull request can be linked to: not done, not linking it yet, latest change first. */
export function linkableCards(board: Board, cwd: string, ref: Pick<GithubRef, "host" | "repo" | "number">): Card[] {
  const key = githubKey(ref);
  return board.cards
    .filter((card) => card.cwd === cwd && card.column !== "done" && card.github.length < LIMITS.github && !card.github.some((other) => githubKey(other) === key))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LINKABLE);
}

/** A To do card for an issue or pull request: its title, its description as the notes, linked to it. */
export function cardFromItem(cwd: string, repo: GithubRepo, item: GithubItem): Extract<BoardOp, { type: "add" }> {
  return {
    type: "add",
    title: item.title.trim().slice(0, LIMITS.title) || refLabel(item),
    notes: imagesAsLinks(item.body).trim().slice(0, LIMITS.notes),
    cwd,
    column: "todo",
    github: [itemRef(repo, item)],
  };
}

const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;
const imageLabel = (alt: string | undefined) => (alt?.trim() && alt.trim().toLowerCase() !== "image" ? `Image: ${alt.trim().replace(/[[\]<>]/g, "")}` : "Image");

/**
 * An issue or pull request's Markdown with its images (<img> and ![]()) as links, outside code: the window's CSP
 * blocks remote images, and whoever reads a card's notes can follow a link.
 */
export function imagesAsLinks(markdown: string): string {
  return markdown
    .split(CODE)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/<img\b[^>]*>/gi, (tag) => {
              const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
              // An <a>, not a Markdown link: <img> is often inside an HTML block, where Markdown is not parsed.
              return src ? `<a href="${src.replace(/"/g, "&quot;")}">${imageLabel(tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2])}</a>` : "";
            })
            .replace(/!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(["']).*?\3)?\s*\)/g, (_, alt: string, src: string) => `[${imageLabel(alt)}](${src})`),
    )
    .join("");
}

/** An issue or pull request's state as GitHub draws it. */
export type ItemLook = "open" | "draft" | "closed" | "merged";

export function itemLook(item: Pick<GithubItem, "kind" | "state" | "draft">): ItemLook {
  if (item.state === "merged") return "merged";
  if (item.state === "closed") return "closed";
  return item.kind === "pr" && item.draft ? "draft" : "open";
}

/** A label's color for a style, or undefined when gh sent something that is not a hex color. */
export const labelColor = (color: string): string | undefined => (/^[0-9a-f]{6}$/i.test(color) ? `#${color}` : undefined);
