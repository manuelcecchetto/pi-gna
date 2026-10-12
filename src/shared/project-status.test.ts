import { describe, expect, it } from "vitest";
import { ciOf, isBranchName, parseGitStatus, summarize } from "./project-status";

describe("parseGitStatus", () => {
  it("reads the branch, upstream, ahead/behind, changed paths, last commit and other branches", () => {
    const porcelain = ["# branch.oid abc", "# branch.head dev", "# branch.upstream origin/dev", "# branch.ab +2 -20", "1 .M N... 100644 100644 100644 a b src/x.ts", "? notes.md", ""].join("\n");
    const status = parseGitStatus(porcelain, "9a9e134\x1freword line\x1f1760000000\n", "dev\nmain\n--force\nfeature/x\n");
    expect(status).toEqual({
      branch: "dev",
      upstream: "origin/dev",
      ahead: 2,
      behind: 20,
      changed: 2,
      last: { sha: "9a9e134", subject: "reword line", at: 1760000000000 },
      branches: ["main", "feature/x"],
    });
  });

  it("leaves the branch out when HEAD is detached and has no upstream counts without one", () => {
    const status = parseGitStatus("# branch.oid abc\n# branch.head (detached)\n", "", "");
    expect(status).toEqual({ ahead: 0, behind: 0, changed: 0, branches: [] });
  });

  it("refuses option-like branch names", () => {
    expect(isBranchName("feature/a.b-c")).toBe(true);
    expect(isBranchName("--upload-pack=x")).toBe(false);
    expect(isBranchName("a b")).toBe(false);
  });
});

describe("ciOf", () => {
  it("is failing on any failed check, pending while one runs, passing otherwise", () => {
    expect(ciOf([])).toBeUndefined();
    expect(ciOf([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "ERROR" }])).toBe("failing");
    expect(ciOf([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pending");
    expect(ciOf([{ status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }])).toBe("passing");
  });
});

describe("summarize", () => {
  const repo = { host: "github.com", repo: "o/r" };
  const ok = [{ status: "COMPLETED", conclusion: "SUCCESS" }];
  const bad = [{ status: "COMPLETED", conclusion: "FAILURE" }];
  it("counts the open pull requests and lists yours, ready ones first", () => {
    const summary = summarize(
      repo,
      "Me",
      [
        { number: 1, title: "old draft", url: "u1", isDraft: true, author: { login: "me" }, statusCheckRollup: ok },
        { number: 2, title: "failing", url: "u2", reviewDecision: "CHANGES_REQUESTED", author: { login: "me" }, statusCheckRollup: bad },
        { number: 3, title: "ready", url: "u3", reviewDecision: "APPROVED", author: { login: "me" }, statusCheckRollup: ok },
        { number: 4, title: "theirs", url: "u4", reviewDecision: "APPROVED", author: { login: "you" }, statusCheckRollup: bad },
      ],
      [],
      100,
    );
    expect(summary.prs).toMatchObject({ open: 4, more: false, drafts: 1, approved: 2, changes: 1, failing: 2, ready: 1 });
    expect(summary.prs.mine.map((pr) => pr.number)).toEqual([3, 2, 1]);
  });

  it("counts issues, their top labels and the most recently updated", () => {
    const issue = (number: number, updatedAt: string, labels: string[]) => ({ number, title: `#${number}`, url: `u${number}`, updatedAt, labels: labels.map((name) => ({ name })) });
    const summary = summarize(repo, "me", [], [issue(1, "2026-01-01", ["bug"]), issue(2, "2026-03-01", ["bug", "web"]), issue(3, "2026-02-01", ["word"])], 2);
    expect(summary.issues).toEqual({
      open: 2,
      more: true,
      labels: [
        { name: "bug", count: 2 },
        { name: "web", count: 1 },
      ],
      recent: [
        { number: 2, title: "#2", url: "u2" },
        { number: 1, title: "#1", url: "u1" },
      ],
    });
  });
});
