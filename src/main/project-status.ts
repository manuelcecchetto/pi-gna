// The status card's checkout (src/shared/project-status.ts): git status of the chat's directory, and the two things
// the card can do to it, pull (fast-forward only) and switch to another local branch. Nothing here fetches: "behind"
// is as of the last fetch, so opening an empty chat never touches the network or the checkout.
import { execFile } from "node:child_process";
import { type GitResult, type GitStatus, isBranchName, parseGitStatus } from "../shared/project-status";

export type GitRun = (cwd: string, args: string[], timeout: number) => Promise<string>;

const runGit: GitRun = (cwd, args, timeout) =>
  new Promise((resolve, reject) =>
    execFile("git", ["-C", cwd, ...args], { env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    ),
  );

/** The checkout at `cwd`; null outside a git repository (or without git). */
export async function gitStatus(cwd: string, git: GitRun = runGit): Promise<GitStatus | null> {
  try {
    const [porcelain, log, branches] = await Promise.all([
      git(cwd, ["status", "--porcelain=v2", "--branch"], 10_000),
      // An empty repository has no commit yet.
      git(cwd, ["log", "-1", "--format=%h%x1f%s%x1f%ct"], 10_000).catch(() => ""),
      git(cwd, ["for-each-ref", "--sort=-committerdate", "--count=12", "--format=%(refname:short)", "refs/heads"], 10_000).catch(() => ""),
    ]);
    return parseGitStatus(porcelain, log, branches);
  } catch {
    return null;
  }
}

const result = (ok: boolean, text: string, fallback: string): GitResult => ({ ok, message: text.trim().split("\n").slice(-3).join("\n") || fallback });

/** `git pull --ff-only`: never a merge commit or a rebase from a click. */
export async function gitPull(cwd: string, git: GitRun = runGit): Promise<GitResult> {
  return git(cwd, ["pull", "--ff-only"], 120_000).then(
    (stdout) => result(true, stdout, "Pulled"),
    (error: Error) => result(false, error.message, "Pull failed"),
  );
}

/** Switch to a local branch; git refuses when uncommitted changes would be overwritten. */
export async function gitSwitch(cwd: string, branch: string, git: GitRun = runGit): Promise<GitResult> {
  if (!isBranchName(branch)) return { ok: false, message: `Not a branch name: ${branch}` };
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 10_000);
  } catch {
    return { ok: false, message: `No local branch ${branch}` };
  }
  return git(cwd, ["switch", branch], 60_000).then(
    (stdout) => result(true, stdout, `Switched to ${branch}`),
    (error: Error) => result(false, error.message, `Could not switch to ${branch}`),
  );
}
