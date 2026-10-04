---
name: pr-review
description: Review a GitHub pull request by number or URL with the GitHub CLI, without touching the user's checkout. Use when asked to review a PR (pi-gna's GitHub page starts these chats), to check a PR's diff for bugs, regressions, security problems and missing tests, or to give a merge recommendation. Findings stay in the chat; nothing is posted to GitHub unless the user asks.
---

# PR review

Review one pull request and report findings the author can act on. Read-only by default: the user's working tree, branches and the pull request on GitHub stay as they are.

## 1. Read the pull request

```bash
gh pr view <N> --repo <owner/name> --json number,title,body,author,state,isDraft,baseRefName,headRefName,headRefOid,files,commits,reviewDecision,statusCheckRollup
gh pr diff <N> --repo <owner/name>
gh pr view <N> --repo <owner/name> --comments   # earlier reviews and discussion
```

- On GitHub Enterprise, prefix gh with `GH_HOST=<host>`.
- If gh answers 404, "Could not resolve to a Repository" or "Bad credentials", the active gh account may not see the repository. When the prompt names the account to use, run gh as that account without switching the active one, for example `GH_TOKEN="$(gh auth token --hostname github.com --user <login>)" gh pr view ...`. Never print the token.
- Read linked issues the description names (`gh issue view`) when they define what the change must do.
- For a very large diff, list the files first (`gh pr diff <N> --name-only`) and review the risky ones (logic, auth, data, migrations, public APIs) in full before skimming the rest.

## 2. Get the code at the pull request's head, beside the checkout

Diff hunks are not enough to judge a change: read the surrounding code, the callers and the tests.

```bash
git fetch <remote> pull/<N>/head            # GitHub's ref for the PR; does not touch the working tree
git show FETCH_HEAD:<path>                  # a file as the PR leaves it
git diff <remote>/<base>...FETCH_HEAD       # the PR's own changes
```

- Do not run `gh pr checkout`, `git checkout`, `git switch`, `git stash` or `git reset` in the user's checkout: it may hold their uncommitted work.
- To build or run tests, use a temporary worktree and remove it when done:
  `git worktree add --detach "$(mktemp -d)/pr-<N>" FETCH_HEAD` … `git worktree remove --force <path>`.
  Install dependencies there only if the checks need them, and say what you ran.
- If the project is not this repository (a fork, another remote), say so and review from `gh pr diff` and `gh api` file reads.

## 3. Review

Read the project's own guidance first (AGENTS.md, CLAUDE.md, CONTRIBUTING, docs near the changed code) and judge the change against it and against the pull request's stated goal.

Look for, in this order:

1. **Correctness**: logic errors, wrong conditions, off-by-one, null and empty cases, error paths, concurrency and ordering, state that can go stale.
2. **Breakage**: changed behavior for existing callers, public APIs, persisted data, migrations, config and compatibility.
3. **Security and privacy**: injection, missing authorization, secrets in code or logs, unsafe input handling, new dependencies.
4. **Tests**: whether the change is covered where it can break; tests that were weakened or only assert the implementation.
5. **Design and maintainability**: duplication, special cases, dead code, naming, code that reads unlike its surroundings. Only what matters; skip taste.

Check CI status (`statusCheckRollup`) and, when cheap, run the relevant tests or typecheck in the temporary worktree. Verify a suspected bug against the code before reporting it; when you cannot, say it is unverified.

## 4. Report

- **Summary**: what the pull request does and your verdict (ready to merge, merge after fixes, or needs rework), in two or three sentences.
- **Findings**, most severe first, each with `path:line` (at the PR's head), what is wrong, why it matters and a concrete fix:
  - **Blocking**: bugs, security problems, breakage, data loss.
  - **Should fix**: missing tests, risky design, unclear behavior.
  - **Nits**: optional, few.
- **Checked**: what you ran (tests, typecheck, builds) and their result, and what you could not check.

Say plainly when there is nothing significant to report rather than inventing findings.

## 5. GitHub

Do not comment, approve, request changes, push, merge or close on GitHub unless the user asks in this chat. When they do, show the exact review text first, then post it with `gh pr review <N> --comment|--approve|--request-changes --body-file <file>` or `gh pr comment`.
