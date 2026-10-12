// The status card above an empty chat's composer, built like the queue card: the checkout, the repository's pull
// requests and issues, and the project's board, each opening a menu of what is behind its number. Git is read when
// the chat opens; gh at most once a minute per project (Github.summary). Nothing here fetches or writes on its own.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { projectOf } from "../../../shared/board";
import { refLine } from "../../../shared/github";
import { type GithubSummary, type GitStatus, isReady, type StatusPr } from "../../../shared/project-status";
import { relativeTime } from "../lib/format";
import { showPage, toast, useApp } from "../state/app";
import { ArrowDown, CircleDot, GitBranch, GitPullRequest, LoaderCircle, SquareKanban } from "./icons";
import { Popover } from "./primitives";

type Menu = "branch" | "prs" | "issues" | "board";

/** `onInsert`: put a line about a pull request or issue into the composer. */
export function StatusCard({ cwd, onInsert }: { cwd: string; onInsert: (text: string) => void }) {
  const [git, setGit] = useState<GitStatus | null>();
  const [github, setGithub] = useState<GithubSummary | null>();
  const [menu, setMenu] = useState<Menu>();
  const [busy, setBusy] = useState(false);
  const kanban = useApp((state) => state.settings.features.kanban);
  const board = useApp((state) => state.board);
  const close = useCallback(() => setMenu(undefined), []);

  const readGit = useCallback(() => window.studio.status.git(cwd).then(setGit, () => setGit(null)), [cwd]);
  useEffect(() => {
    let live = true;
    setGit(undefined);
    setGithub(undefined);
    window.studio.status.git(cwd).then((value) => live && setGit(value), () => live && setGit(null));
    window.studio.status.github(cwd).then((value) => live && setGithub(value), () => live && setGithub(null));
    return () => {
      live = false;
    };
  }, [cwd]);

  const cards = kanban ? board.cards.filter((card) => card.cwd === projectOf(cwd) && card.column !== "done") : [];
  const review = cards.filter((card) => card.column === "in_review");
  const todo = cards.filter((card) => card.column === "todo" || card.column === "in_progress");
  if (!git && !github && !cards.length) return null;

  const run = async (work: () => Promise<{ ok: boolean; message: string }>) => {
    setMenu(undefined);
    setBusy(true);
    try {
      const result = await work();
      toast(result.message, result.ok ? "info" : "error");
    } finally {
      setBusy(false);
      void readGit();
    }
  };
  const insert = (text: string) => {
    setMenu(undefined);
    onInsert(text);
  };
  const toggle = (which: Menu) => setMenu(menu === which ? undefined : which);
  const ref = (kind: "pr" | "issue", item: { number: number; title: string; url: string }) =>
    github ? refLine({ kind, host: github.repo.host, repo: github.repo.repo, number: item.number, url: item.url, title: item.title }) : item.url;

  const segments: ReactNode[] = [];
  if (git) {
    segments.push(
      <Segment key="branch" open={menu === "branch"} onClick={() => toggle("branch")} title="Branch">
        {busy ? <LoaderCircle size={14} className="animate-spin text-accent" /> : <GitBranch size={14} className="text-accent" />}
        <b className="font-medium text-fg">{git.branch ?? "detached"}</b>
        {git.behind > 0 && <span className="text-warn">↓{git.behind}</span>}
        {git.ahead > 0 && <span className="text-accent">↑{git.ahead}</span>}
        {git.changed > 0 && <span className="text-faint">±{git.changed}</span>}
      </Segment>,
    );
  }
  if (github) {
    const { prs, issues } = github;
    segments.push(
      <Segment key="prs" open={menu === "prs"} onClick={() => toggle("prs")} title="Pull requests">
        <GitPullRequest size={14} />
        <b className="font-medium text-fg">{prs.open}{prs.more ? "+" : ""}</b> PRs
        {prs.ready > 0 && (
          <>
            <span className="text-faint">·</span>
            <b className="font-medium text-fg">{prs.ready}</b> ready
          </>
        )}
        {prs.failing > 0 && (
          <>
            <span className="text-faint">·</span>
            <span className="text-bad">{prs.failing} failing</span>
          </>
        )}
      </Segment>,
      <Segment key="issues" open={menu === "issues"} onClick={() => toggle("issues")} title="Issues">
        <CircleDot size={14} />
        <b className="font-medium text-fg">{issues.open}{issues.more ? "+" : ""}</b> issues
      </Segment>,
    );
  }
  if (cards.length) {
    segments.push(
      <Segment key="board" open={menu === "board"} onClick={() => toggle("board")} title="Board">
        <SquareKanban size={14} />
        {review.length ? (
          <>
            <b className="font-medium text-fg">{review.length}</b> in review
          </>
        ) : (
          <>
            <b className="font-medium text-fg">{todo.length}</b> open
          </>
        )}
      </Segment>,
    );
  }

  return (
    <div className="relative z-[1] mx-auto -mb-6 flex w-fit max-w-[calc(100%-2rem)] items-center rounded-t-2xl border border-line-strong bg-raised px-1.5 pt-1 pb-7" data-testid="status-card">
      {segments.map((segment, index) => (
        <div key={index} className="flex min-w-0 items-center">
          {index > 0 && <span className="mx-0.5 h-3.5 w-px shrink-0 bg-line-strong" />}
          {segment}
        </div>
      ))}

      <Popover open={menu === "branch"} onClose={close} className="bottom-full left-1/2 mb-1.5 w-[440px] -translate-x-1/2 p-1">
        {git && (
          <>
            <Heading>{branchLine(git)}</Heading>
            {git.upstream && git.behind > 0 && (
              <Row icon={<ArrowDown size={13} />} onClick={() => void run(() => window.studio.status.pull(cwd))}>
                Pull {git.behind} {git.behind === 1 ? "commit" : "commits"}
              </Row>
            )}
            {git.branches.slice(0, 5).map((branch) => (
              <Row key={branch} icon={<GitBranch size={13} />} onClick={() => void run(() => window.studio.status.switchBranch(cwd, branch))}>
                Switch to <span className="font-mono text-[12px]">{branch}</span>
              </Row>
            ))}
            {git.last && (
              <>
                <Separator />
                <Row mono={git.last.sha} meta={relativeTime(git.last.at)}>
                  {git.last.subject}
                </Row>
              </>
            )}
          </>
        )}
      </Popover>

      <Popover open={menu === "prs"} onClose={close} className="bottom-full left-1/2 mb-1.5 w-[480px] -translate-x-1/2 p-1">
        {github && (
          <>
            <Heading>{github.prs.mine.length ? `Yours, as ${github.login}` : `None of the open pull requests are by ${github.login}`}</Heading>
            {github.prs.mine.slice(0, 6).map((pr) => (
              <Row key={pr.number} mono={`#${pr.number}`} meta={<PrState pr={pr} />} onClick={() => insert(ref("pr", pr))}>
                {pr.title}
              </Row>
            ))}
            <Separator />
            <Row
              meta="GitHub page"
              onClick={() => {
                setMenu(undefined);
                showPage("github", projectOf(cwd));
              }}
            >
              <span className="text-muted">
                {github.prs.approved} approved · {github.prs.changes} changes requested · {github.prs.drafts} drafts
              </span>
            </Row>
          </>
        )}
      </Popover>

      <Popover open={menu === "issues"} onClose={close} className="bottom-full left-1/2 mb-1.5 w-[480px] -translate-x-1/2 p-1">
        {github && (
          <>
            <Heading>Recently updated</Heading>
            {github.issues.recent.map((issue) => (
              <Row key={issue.number} mono={`#${issue.number}`} onClick={() => insert(ref("issue", issue))}>
                {issue.title}
              </Row>
            ))}
            <Separator />
            <Row
              meta="GitHub page"
              onClick={() => {
                setMenu(undefined);
                showPage("github", projectOf(cwd));
              }}
            >
              <span className="text-muted">{github.issues.labels.map((label) => `${label.count} ${label.name}`).join(" · ") || `${github.issues.open} open`}</span>
            </Row>
          </>
        )}
      </Popover>

      <Popover open={menu === "board"} onClose={close} className="bottom-full left-1/2 mb-1.5 w-[440px] -translate-x-1/2 p-1">
        {review.length > 0 && <Heading>In review</Heading>}
        {review.slice(0, 4).map((card) => (
          <CardRow key={card.id} title={card.title} chats={card.chats.length} onClick={() => (setMenu(undefined), showPage("kanban", card.cwd, card.id))} />
        ))}
        {todo.length > 0 && <Heading>To do and in progress</Heading>}
        {todo.slice(0, 4).map((card) => (
          <CardRow key={card.id} title={card.title} chats={card.chats.length} onClick={() => (setMenu(undefined), showPage("kanban", card.cwd, card.id))} />
        ))}
        <Separator />
        <Row meta="Board" onClick={() => (setMenu(undefined), showPage("kanban", projectOf(cwd)))}>
          <span className="text-muted">{cards.length} not done</span>
        </Row>
      </Popover>
    </div>
  );
}

/** "dev · clean · 20 behind origin/dev". */
function branchLine(git: GitStatus): string {
  const parts = [git.branch ?? "detached HEAD", git.changed ? `${git.changed} changed` : "clean"];
  if (git.upstream) {
    const counts = [git.behind && `${git.behind} behind`, git.ahead && `${git.ahead} ahead`].filter(Boolean).join(", ");
    parts.push(counts ? `${counts} ${git.upstream}` : `up to date with ${git.upstream}`);
  }
  return parts.join(" · ");
}

function Segment({ open, onClick, title, children }: { open: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex min-w-0 items-center gap-1.5 truncate rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap hover:bg-panel hover:text-fg ${open ? "bg-panel text-fg" : "text-muted"}`}
    >
      {children}
    </button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] text-faint">{children}</div>;
}

function Separator() {
  return <div className="mx-1.5 my-1 h-px bg-line" />;
}

function Row({ icon, mono, meta, onClick, children }: { icon?: ReactNode; mono?: string; meta?: ReactNode; onClick?: () => void; children: ReactNode }) {
  const body = (
    <>
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      {mono && <span className="shrink-0 font-mono text-[12px] text-faint">{mono}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-faint">{meta}</span>}
    </>
  );
  const className = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} hover:bg-raised`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

function CardRow({ title, chats, onClick }: { title: string; chats: number; onClick: () => void }) {
  return (
    <Row onClick={onClick} meta={chats ? `${chats} ${chats === 1 ? "chat" : "chats"}` : undefined}>
      {title}
    </Row>
  );
}

function PrState({ pr }: { pr: StatusPr }) {
  const [dot, label] = isReady(pr)
    ? ["bg-ok", "ready"]
    : pr.ci === "failing"
      ? ["bg-bad", pr.review === "changes_requested" ? "CI · changes" : "CI failing"]
      : pr.review === "changes_requested"
        ? ["bg-warn", "changes"]
        : pr.draft
          ? ["bg-faint", "draft"]
          : pr.ci === "pending"
            ? ["bg-warn", "CI running"]
            : ["bg-faint", "in review"];
  return (
    <>
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </>
  );
}
