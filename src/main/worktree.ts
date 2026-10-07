// Resolve chats work in a git worktree of their card's project, on a branch of their own, so what they change stays
// off your checkout until you merge it; a lament's Fix chats do the same, keyed by the lament's id (lament and card
// ids are both six random characters). The worktree lives outside the project (shared/board.ts worktreeCwd) and
// stays until you remove it (`git worktree remove`): the chat reopens there, and a second Resolve reuses it.
// A new ATP plan's architect works in one too, on a pigna/atp-<id> branch (atpWorktree; Atp.newPlanCwd).
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import { worktreeCwd } from "../shared/board";
import type { CardWorktree } from "../shared/ipc";

const BRANCHES = "pigna/";
/** The branches of new ATP plans' worktrees: pigna/atp-<id>, which no card's branch (pigna/<card id>-…) can be. */
export const ATP_BRANCHES = `${BRANCHES}atp-`;
const SLUG = 40;

const pending = new Map<string, Promise<CardWorktree | null>>();

/**
 * The card's worktree, made on first use from the checkout's HEAD (or the card's branch, when an earlier worktree
 * was removed). Null when the project is not in a git repository. One at a time per card, so a second Resolve
 * waits for the first to make the worktree and then reuses it.
 */
export function cardWorktree(project: string, card: { id: string; title: string }, home = homedir()): Promise<CardWorktree | null> {
  return serialized(project, card.id, home, () => prepare(project, card.id, [`${BRANCHES}${card.id}`, `${BRANCHES}${card.id}-*`], branchName(card), home));
}

/** A worktree for a new ATP plan, keyed by a fresh id (a card's id shape, so projectOf maps its chats back). */
export function atpWorktree(project: string, id: string, home = homedir()): Promise<CardWorktree | null> {
  const branch = `${ATP_BRANCHES}${id}`;
  return serialized(project, id, home, () => prepare(project, id, [branch], branch, home));
}

function serialized(project: string, id: string, home: string, make: () => Promise<CardWorktree | null>): Promise<CardWorktree | null> {
  const key = worktreeCwd(home, id, project);
  const run = (pending.get(key) ?? Promise.resolve(null)).catch(() => null).then(make);
  pending.set(key, run);
  const settle = () => {
    if (pending.get(key) === run) pending.delete(key);
  };
  run.then(settle, settle);
  return run;
}

/** The worktree of `id`, on the first existing branch matching `patterns` (an earlier, removed worktree's), else on `fresh` from HEAD. */
async function prepare(project: string, id: string, patterns: string[], fresh: string, home: string): Promise<CardWorktree | null> {
  // The project's path below the repository's top folder ("" at the top). In C, so the error reads the same in any language.
  const prefix = await git(project, ["rev-parse", "--show-prefix"], { LC_ALL: "C" }).catch((error: Error) => {
    if (/not a git repository/.test(error.message)) return null;
    throw error;
  });
  if (prefix === null) return null;
  // The worktree mirrors the repository, and the chat runs in the project's folder in it. Both are spelled as you
  // opened the project (git's paths are real paths), so projectOf maps the chat back to the card's project.
  const sub = prefix.replace(/\/$/, "").replaceAll("/", sep);
  if (sub && !project.endsWith(`${sep}${sub}`)) throw new Error(`${project} links into its git repository; open the repository's folder itself`);
  const top = sub ? project.slice(0, -sub.length - 1) : project;
  const dir = worktreeCwd(home, id, top);
  const cwd = worktreeCwd(home, id, project);
  const dirty = (await git(project, ["status", "--porcelain"])) !== "";

  if (await isWorktree(dir)) return { cwd, branch: await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), created: false, dirty };
  // Forget worktrees whose folders were deleted: one of them may hold this path or the branch.
  await git(project, ["worktree", "prune"]);
  const branches = await git(project, ["for-each-ref", "--format=%(refname)", ...patterns.map((pattern) => `refs/heads/${pattern}`)]);
  const existing = branches.split("\n").find(Boolean)?.replace(/^refs\/heads\//, "");
  const branch = existing ?? fresh;
  await git(project, existing ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { cwd, branch, created: true, dirty };
}

/** pigna/<card id>-<the title's first words>. */
export function branchName(card: { id: string; title: string }): string {
  const slug = card.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const cut = slug.lastIndexOf("-", SLUG);
  const short = slug.length <= SLUG ? slug : slug.slice(0, cut > 0 ? cut : SLUG);
  return short ? `${BRANCHES}${card.id}-${short}` : `${BRANCHES}${card.id}`;
}

/** A worktree's top folder, not just a folder inside some repository (say, a home folder kept in git). */
async function isWorktree(dir: string): Promise<boolean> {
  if (!(await stat(dir).catch(() => undefined))?.isDirectory()) return false;
  const top = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => "");
  return top !== "" && top === (await realpath(dir));
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`)) : resolve(stdout.trim()),
    ),
  );
}
