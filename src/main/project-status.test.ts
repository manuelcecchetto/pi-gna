import { describe, expect, it, vi } from "vitest";
import { type GitRun, gitPull, gitStatus, gitSwitch } from "./project-status";

describe("project status git", () => {
  it("is null outside a repository", async () => {
    const git: GitRun = async () => {
      throw new Error("fatal: not a git repository");
    };
    expect(await gitStatus("/tmp/x", git)).toBeNull();
  });

  it("reads status, last commit and branches", async () => {
    const git: GitRun = async (_cwd, args) =>
      args[0] === "status" ? "# branch.head main\n# branch.ab +0 -3\n" : args[0] === "log" ? "abc1234\x1fsubject\x1f100\n" : "main\nother\n";
    expect(await gitStatus("/repo", git)).toMatchObject({ branch: "main", behind: 3, last: { sha: "abc1234" }, branches: ["other"] });
  });

  it("pulls fast-forward only and reports git's message", async () => {
    const git = vi.fn<GitRun>(async () => {
      throw new Error("fatal: Not possible to fast-forward, aborting.");
    });
    expect(await gitPull("/repo", git)).toEqual({ ok: false, message: "fatal: Not possible to fast-forward, aborting." });
    expect(git.mock.calls[0]?.[1]).toEqual(["pull", "--ff-only"]);
  });

  it("switches only to an existing local branch with a plain name", async () => {
    const git = vi.fn<GitRun>(async () => "");
    expect(await gitSwitch("/repo", "--orphan", git)).toEqual({ ok: false, message: "Not a branch name: --orphan" });
    expect(git).not.toHaveBeenCalled();
    expect(await gitSwitch("/repo", "feature/a", git)).toEqual({ ok: true, message: "Switched to feature/a" });
    expect(git.mock.calls.map((call) => call[1][0])).toEqual(["rev-parse", "switch"]);
  });
});
