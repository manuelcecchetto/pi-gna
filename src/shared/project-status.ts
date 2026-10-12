// The project status card above an empty chat's composer: the checkout (git) and the repository's pull requests and
// issues (gh), read by main (src/main/project-status.ts, Github.summary) and parsed here so both stay testable.
import type { GithubRepo } from "./github";

/** The checkout: its branch, how it stands against its upstream (as of the last fetch), and its last commit. */
export interface GitStatus {
  /** Absent when HEAD is detached. */
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Changed, staged, conflicted and untracked paths. */
  changed: number;
  last?: { sha: string; subject: string; at: number };
  /** Other local branches, most recently committed first. */
  branches: string[];
}

/** What a pull request needs: CI from its checks, the review from reviewDecision. */
export type CiState = "passing" | "failing" | "pending";

export interface StatusPr {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  review?: "approved" | "changes_requested" | "review_required";
  ci?: CiState;
}

export interface StatusIssue {
  number: number;
  title: string;
  url: string;
}

export interface GithubSummary {
  repo: GithubRepo;
  /** The gh account the repository is read as; "yours" means authored by it. */
  login: string;
  prs: { open: number; more: boolean; drafts: number; approved: number; changes: number; failing: number; ready: number; mine: StatusPr[] };
  issues: { open: number; more: boolean; labels: { name: string; count: number }[]; recent: StatusIssue[] };
}

/** What pulling or switching did, in git's words. */
export interface GitResult {
  ok: boolean;
  message: string;
}

/** Branch names git can switch to from a click: no option-like or odd names reach `git switch`. */
const BRANCH = /^(?!-)[\w./-]{1,200}$/;

/** `git status --porcelain=v2 --branch` plus `git log -1 --format=%h%x1f%s%x1f%ct` and the recent branches. */
export function parseGitStatus(porcelain: string, log: string, branches: string): GitStatus {
  const status: GitStatus = { ahead: 0, behind: 0, changed: 0, branches: [] };
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14);
      if (head !== "(detached)") status.branch = head;
    } else if (line.startsWith("# branch.upstream ")) status.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) [status.ahead, status.behind] = [Number(match[1]), Number(match[2])];
    } else if (!line.startsWith("#")) status.changed++;
  }
  const [sha, subject, at] = log.trim().split("\x1f");
  if (sha && subject !== undefined && at) status.last = { sha, subject, at: Number(at) * 1000 };
  status.branches = branches
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name && name !== status.branch && BRANCH.test(name))
    .slice(0, 8);
  return status;
}

export const isBranchName = (name: string): boolean => BRANCH.test(name);

/** gh's statusCheckRollup: check runs (status, conclusion) and commit statuses (state). */
export interface RawCheck {
  status?: string;
  conclusion?: string;
  state?: string;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/** Failing if any check failed, pending if any is still running, passing otherwise; none without checks. */
export function ciOf(checks: RawCheck[] | null | undefined): CiState | undefined {
  if (!checks?.length) return undefined;
  if (checks.some((check) => FAILED.has(check.conclusion ?? "") || FAILED.has(check.state ?? ""))) return "failing";
  if (checks.some((check) => (check.status !== undefined && check.status !== "COMPLETED") || check.state === "PENDING" || check.state === "EXPECTED")) return "pending";
  return "passing";
}

export interface RawStatusPr {
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  reviewDecision?: string;
  author?: { login?: string } | null;
  statusCheckRollup?: RawCheck[] | null;
}

export interface RawStatusIssue {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  labels?: { name: string }[];
}

/** Ready to merge: not a draft, approved, CI not failing or running. */
export const isReady = (pr: StatusPr): boolean => !pr.draft && pr.review === "approved" && (pr.ci === undefined || pr.ci === "passing");

/** Yours first the ones that need you: ready, then failing CI or changes requested, then the rest. */
const rank = (pr: StatusPr) => (isReady(pr) ? 0 : pr.ci === "failing" || pr.review === "changes_requested" ? 1 : 2);

export function summarize(repo: GithubRepo, login: string, prs: RawStatusPr[], issues: RawStatusIssue[], limit: number): GithubSummary {
  const all = prs.slice(0, limit).map((raw) => {
    const review = raw.reviewDecision?.toLowerCase();
    const pr: StatusPr = { number: raw.number, title: raw.title, url: raw.url, draft: raw.isDraft === true, ci: ciOf(raw.statusCheckRollup) };
    if (review === "approved" || review === "changes_requested" || review === "review_required") pr.review = review;
    return { pr, mine: raw.author?.login?.toLowerCase() === login.toLowerCase() };
  });
  const issuesMore = issues.length > limit;
  const labels = new Map<string, number>();
  issues = issues.slice(0, limit);
  for (const issue of issues) for (const label of issue.labels ?? []) labels.set(label.name, (labels.get(label.name) ?? 0) + 1);
  const mine = all.filter((entry) => entry.mine).map((entry) => entry.pr);
  return {
    repo,
    login,
    prs: {
      open: Math.min(prs.length, limit),
      more: prs.length > limit,
      drafts: all.filter(({ pr }) => pr.draft).length,
      approved: all.filter(({ pr }) => pr.review === "approved").length,
      changes: all.filter(({ pr }) => pr.review === "changes_requested").length,
      failing: all.filter(({ pr }) => pr.ci === "failing").length,
      ready: mine.filter(isReady).length,
      mine: mine.sort((a, b) => rank(a) - rank(b) || b.number - a.number),
    },
    issues: {
      open: issues.length,
      more: issuesMore,
      labels: [...labels].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3),
      recent: [...issues]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 4)
        .map(({ number, title, url }) => ({ number, title, url })),
    },
  };
}
