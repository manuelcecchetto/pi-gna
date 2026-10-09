import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectOf, worktreeCwd } from "../shared/board";
import { branchName, cardWorktree } from "./worktree";

const card = { id: "abc123", title: "Fix the flash" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// Real git in a temporary folder, spelled as tmpdir() gives it (a symlink on macOS), with a home of its own.
let root: string;
let repo: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pigna-worktree-"));
  repo = join(root, "repo");
  home = join(root, "home");
  // Your git config (signing, hooks) stays out of it.
  await writeFile(join(root, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  await mkdir(join(repo, "web"), { recursive: true });
  await writeFile(join(repo, "web", "app.ts"), "export {};\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "start");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("worktreeCwd", () => {
  it("mirrors a Windows project's drive or share as a folder, and map back to it", () => {
    const home = "C:\\Users\\me";
    for (const project of ["C:\\Users\\me\\Code\\app", "D:\\", "C:/Users/me/app", "\\\\server\\share\\app"]) {
      const cwd = worktreeCwd(`${home}\\`, "abc123", project);
      expect(win32.isAbsolute(cwd)).toBe(true);
      expect(cwd.indexOf(":", 2)).toBe(-1);
      expect(cwd.startsWith(win32.join(home, ".pi-gna", "worktrees", "abc123"))).toBe(true);
      expect(projectOf(cwd)).toBe(project);
    }
    expect(worktreeCwd(home, "abc123", "C:\\Users\\me\\Code\\app")).toBe(win32.join(home, ".pi-gna", "worktrees", "abc123", "C", "Users", "me", "Code", "app"));
    expect(worktreeCwd(home, "abc123", "\\\\server\\share")).toBe(win32.join(home, ".pi-gna", "worktrees", "abc123", "UNC", "server", "share"));
    expect(projectOf("C:\\Users\\me\\Code\\app")).toBe("C:\\Users\\me\\Code\\app");
    expect(projectOf(win32.join(home, ".pi-gna", "worktrees", "abc123", "notes", "x"))).toBe(win32.join(home, ".pi-gna", "worktrees", "abc123", "notes", "x"));
  });
});

describe("cardWorktree", () => {
  it("makes a worktree outside the project, on the card's branch from HEAD", async () => {
    const worktree = await cardWorktree(repo, card, home);
    expect(worktree).toEqual({ cwd: worktreeCwd(home, card.id, repo), branch: "pigna/abc123-fix-the-flash", created: true, dirty: false });
    expect(projectOf(worktree?.cwd ?? "")).toBe(repo);
    expect(await readFile(join(worktree?.cwd ?? "", "web", "app.ts"), "utf8")).toBe("export {};\n");
    expect(git(worktree?.cwd ?? "", "rev-parse", "--abbrev-ref", "HEAD")).toBe("pigna/abc123-fix-the-flash");
    // The checkout stays on its branch.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("reuses the card's worktree, also when Resolve runs twice at once", async () => {
    const [first, second] = await Promise.all([cardWorktree(repo, card, home), cardWorktree(repo, card, home)]);
    expect([first?.created, second?.created]).toEqual([true, false]);
    expect(second).toEqual({ ...first, created: false });
    expect(await cardWorktree(repo, card, home)).toEqual({ ...first, created: false });
  });

  it("runs a project in a subfolder of its repository in that folder of the worktree", async () => {
    const project = join(repo, "web");
    const worktree = await cardWorktree(project, card, home);
    expect(worktree?.cwd).toBe(worktreeCwd(home, card.id, project));
    expect(projectOf(worktree?.cwd ?? "")).toBe(project);
    expect(existsSync(join(worktreeCwd(home, card.id, repo), ".git"))).toBe(true);
    expect(existsSync(join(worktree?.cwd ?? "", "app.ts"))).toBe(true);
  });

  it("is null for a project outside git", async () => {
    await mkdir(join(root, "plain"));
    expect(await cardWorktree(join(root, "plain"), card, home)).toBeNull();
  });

  it("says when the checkout has changes the worktree does not", async () => {
    await writeFile(join(repo, "web", "draft.ts"), "wip\n");
    const worktree = await cardWorktree(repo, card, home);
    expect(worktree?.dirty).toBe(true);
    expect(existsSync(join(worktree?.cwd ?? "", "web", "draft.ts"))).toBe(false);
  });

  it("does not look at the checkout's changes when it reuses a worktree (git status is slow in a big repository)", async () => {
    await cardWorktree(repo, card, home);
    await writeFile(join(repo, "web", "draft.ts"), "wip\n");
    expect(await cardWorktree(repo, card, home)).toMatchObject({ created: false, dirty: false, branch: "pigna/abc123-fix-the-flash" });
  });

  it("does not take a folder inside another repository for the worktree", async () => {
    // A home kept in git: the worktree's folder exists, empty, inside that repository, but is no worktree of its own.
    git(root, "init", "-q");
    git(root, "add", "gitconfig");
    git(root, "commit", "-qm", "home");
    await mkdir(worktreeCwd(home, card.id, repo), { recursive: true });
    expect(await cardWorktree(repo, card, home)).toMatchObject({ created: true, branch: "pigna/abc123-fix-the-flash" });
  });

  it("brings back the card's branch, with its commits, after the worktree was removed", async () => {
    const first = await cardWorktree(repo, card, home);
    const cwd = first?.cwd ?? "";
    await writeFile(join(cwd, "web", "fix.ts"), "fixed\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fix");
    git(repo, "worktree", "remove", cwd);
    // A renamed card keeps its branch.
    const again = await cardWorktree(repo, { ...card, title: "Fix the flash for good" }, home);
    expect(again).toEqual({ ...first, created: true });
    expect(existsSync(join(cwd, "web", "fix.ts"))).toBe(true);
  });

  it("reports git's error when it cannot make one", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    git(empty, "init", "-q");
    await expect(cardWorktree(empty, card, home)).rejects.toThrow(/^git worktree failed: /);
  });
});

describe("branchName", () => {
  it("is the card id and the title's first words", () => {
    expect(branchName({ id: "abc123", title: "Ünïcode: résumé & “quotes”!" })).toBe("pigna/abc123-unicode-resume-quotes");
    expect(branchName({ id: "abc123", title: "Run Resolve card chats in a git worktree, not the main checkout" })).toBe(
      "pigna/abc123-run-resolve-card-chats-in-a-git-worktree",
    );
    expect(branchName({ id: "abc123", title: "x".repeat(60) })).toBe(`pigna/abc123-${"x".repeat(40)}`);
    expect(branchName({ id: "abc123", title: "修复" })).toBe("pigna/abc123");
  });
});
