// Resolve chats work in a git worktree of their card's project, on a branch of their own, so what they change stays
// off your checkout until you merge it. The worktree lives outside the project (shared/board.ts worktreeCwd) and
// stays until you remove it (`git worktree remove`): the chat reopens there, and a second Resolve reuses it.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { worktreeCwd } from "../shared/board";
import type { CardWorktree } from "../shared/ipc";

const BRANCHES = "pigna/";
const SLUG = 40;

const pending = new Map<string, Promise<CardWorktree | null>>();

/**
 * The card's worktree, made on first use from the checkout's HEAD (or the card's branch, when an earlier worktree
 * was removed). Null when the project is not in a git repository. One at a time per card, so a second Resolve
 * waits for the first to make the worktree and then reuses it.
 */
export function cardWorktree(project: string, card: { id: string; title: string }, home = homedir()): Promise<CardWorktree | null> {
  const key = worktreeCwd(home, card.id, project);
  const run = (pending.get(key) ?? Promise.resolve(null)).catch(() => null).then(() => prepare(project, card, home));
  pending.set(key, run);
  const settle = () => {
    if (pending.get(key) === run) pending.delete(key);
  };
  run.then(settle, settle);
  return run;
}

async function prepare(project: string, card: { id: string; title: string }, home: string): Promise<CardWorktree | null> {
  // The project's path below the repository's top folder ("" at the top). In C, so the error reads the same in any language.
  const prefix = await git(project, ["rev-parse", "--show-prefix"], { LC_ALL: "C" }).catch((error: Error) => {
    if (/not a git repository/.test(error.message)) return null;
    throw error;
  });
  if (prefix === null) return null;
  // The worktree mirrors the repository, and the chat runs in the project's folder in it. Both are spelled as you
  // opened the project (git's paths are real paths), so projectOf maps the chat back to the card's project.
  const sub = prefix.replace(/\/$/, "");
  if (sub && !project.endsWith(`/${sub}`)) throw new Error(`${project} links into its git repository; open the repository's folder itself`);
  const top = sub ? project.slice(0, -sub.length - 1) : project;
  const dir = worktreeCwd(home, card.id, top);
  const cwd = worktreeCwd(home, card.id, project);
  const dirty = (await git(project, ["status", "--porcelain"])) !== "";

  if (await isWorktree(dir)) return { cwd, branch: await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), created: false, dirty };
  // Forget worktrees whose folders were deleted: one of them may hold this path or the card's branch.
  await git(project, ["worktree", "prune"]);
  const branches = await git(project, ["for-each-ref", "--format=%(refname)", `refs/heads/${BRANCHES}${card.id}`, `refs/heads/${BRANCHES}${card.id}-*`]);
  const existing = branches.split("\n").find(Boolean)?.replace(/^refs\/heads\//, "");
  const branch = existing ?? branchName(card);
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
