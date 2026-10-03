// A project's GitHub issues and pull requests, through the GitHub CLI (gh) in main (src/main/github.ts). The
// repository is the project's git remote; the account is chosen per repository from gh's logged-in accounts, so a
// work and a personal project each use the account that can see them. Tokens never leave main.
import type { GithubRef } from "./board";

export type GithubKind = GithubRef["kind"];
export type GithubState = "open" | "closed" | "merged";
/** The lists the page asks for: closed pull requests include merged ones. */
export type GithubFilter = "open" | "closed";

/** At most this many issues or pull requests per list. */
export const GITHUB_LIST_LIMIT = 100;

/** A repository on a GitHub host. */
export interface GithubRepo {
  host: string;
  /** owner/name. */
  repo: string;
}

/**
 * Why a repository uses an account, in the order main tries them: the one you chose for the project, the one that
 * worked last time, the account named like the repository's owner, a member of the owner organization, any account
 * that can read it.
 */
export type AccountReason = "chosen" | "saved" | "owner" | "member" | "access";

export const ACCOUNT_REASONS: Record<AccountReason, string> = {
  chosen: "chosen for this project",
  saved: "it could read the repository last time",
  owner: "it owns the repository",
  member: "it is a member of the owner organization",
  access: "it can read the repository",
};

export interface GithubProblem {
  /** no-gh: gh is not installed. no-repo: no GitHub remote. no-login: gh has no account on the host. */
  kind: "no-gh" | "no-repo" | "no-login" | "no-access" | "failed";
  message: string;
}

/** The project's repository and the account pi-gna uses for it, or what is in the way. */
export interface GithubProject {
  repo?: GithubRepo;
  /** The account in use (absent with a problem). */
  account?: { login: string; reason: AccountReason };
  /** gh's accounts on the repository's host, for choosing another. */
  accounts: string[];
  /** The account you chose for this project, if any. */
  chosen?: string;
  problem?: GithubProblem;
}

export interface GithubLabel {
  name: string;
  /** Hex without #. */
  color: string;
}

export interface GithubItem {
  kind: GithubKind;
  number: number;
  title: string;
  state: GithubState;
  author: string;
  labels: GithubLabel[];
  createdAt: string;
  updatedAt: string;
  url: string;
  /** Markdown, clipped. */
  body: string;
  /** Pull requests: a draft, its branch, the branch it goes into, and what its reviews decided. */
  draft?: boolean;
  head?: string;
  base?: string;
  review?: "approved" | "changes_requested" | "review_required";
}

export type GithubList = { items: GithubItem[]; /** There are more than GITHUB_LIST_LIMIT. */ more: boolean; problem?: undefined } | { problem: GithubProblem };

export type GithubLookup = { ref: GithubRef; problem?: undefined } | { problem: GithubProblem };

export const repoUrl = (repo: GithubRepo): string => `https://${repo.host}/${repo.repo}`;

/** The link a card keeps to an issue or pull request. */
export const itemRef = (repo: GithubRepo, item: Pick<GithubItem, "kind" | "number" | "url" | "title">): GithubRef => ({
  kind: item.kind,
  host: repo.host,
  repo: repo.repo,
  number: item.number,
  url: item.url,
  title: item.title,
});

/** "issue #12" or "PR #12". */
export const refLabel = (ref: Pick<GithubRef, "kind" | "number">): string => `${ref.kind === "pr" ? "PR" : "issue"} #${ref.number}`;

/** A card's link as agents read it (the card block in a prompt, kanban_list). */
export const refLine = (ref: GithubRef): string => `${refLabel(ref)} of ${ref.repo}${ref.title ? `: ${ref.title}` : ""} (${ref.url})`;

/**
 * Host and owner/name of a git remote URL: https://host/owner/name(.git), git@host:owner/name(.git) or
 * ssh://git@host[:port]/owner/name(.git). Undefined for anything else (a local path, a URL with a deeper path).
 */
export function parseRemote(url: string): GithubRepo | undefined {
  const match =
    url.match(/^(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:[^@/]+@)?([^/:]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!match?.[1] || !match[2] || !/^[\w.-]+\/[\w.-]+$/.test(match[2])) return undefined;
  return { host: match[1].toLowerCase(), repo: match[2] };
}

export interface Remote {
  name: string;
  url: string;
  /** remote.<name>.gh-resolved: "base" when `gh repo set-default` chose it, or the owner/name it resolved to. */
  resolved?: string;
}

const PREFERRED = ["upstream", "github", "origin"];

/**
 * The repository gh would use for a checkout: the remote `gh repo set-default` chose, else upstream, github or
 * origin, else the first remote on a GitHub URL scheme.
 */
export function pickRemote(remotes: Remote[]): GithubRepo | undefined {
  const parsed = remotes.flatMap((remote) => {
    const repo = parseRemote(remote.url);
    return repo ? [{ remote, repo }] : [];
  });
  const base = parsed.find(({ remote }) => remote.resolved === "base");
  if (base) return base.repo;
  const resolved = parsed.find(({ remote }) => remote.resolved && /^[\w.-]+\/[\w.-]+$/.test(remote.resolved));
  if (resolved?.remote.resolved) return { host: resolved.repo.host, repo: resolved.remote.resolved };
  const rank = (name: string) => (PREFERRED.includes(name) ? PREFERRED.indexOf(name) : PREFERRED.length);
  return [...parsed].sort((a, b) => rank(a.remote.name) - rank(b.remote.name))[0]?.repo;
}

/**
 * What you typed to link an issue or pull request of `repo`: "12", "#12" or its URL (issues/12, pull/12, maybe with
 * a tab or anchor after it). Throws an Error that says what is wrong.
 */
export function parseItemInput(input: string, repo: GithubRepo): { number: number; kind?: GithubKind } {
  const text = input.trim();
  const plain = text.match(/^#?(\d{1,9})$/);
  if (plain) return { number: Number(plain[1]) };
  const url = text.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/(issues|pull)\/(\d{1,9})(?:[/?#].*)?$/i);
  if (!url?.[1] || !url[2] || !url[4]) throw new Error("Type an issue or pull request number (#12) or paste its link");
  if (url[1].toLowerCase() !== repo.host || url[2].toLowerCase() !== repo.repo.toLowerCase()) {
    throw new Error(`That links into ${url[2]}; this project's repository is ${repo.repo}`);
  }
  return { number: Number(url[4]), kind: url[3]?.toLowerCase() === "pull" ? "pr" : "issue" };
}
