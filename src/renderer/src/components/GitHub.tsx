// The GitHub page: one project's issues and pull requests, read with gh in main as the account that can see the
// project's repository (src/main/github.ts). Loaded when the page opens and on Refresh, never polled. Open one to read
// it; make a card of it, or link it to a card, so the chats on that card know what they are working on; review a
// pull request in a new chat.
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  Plus,
  RefreshCw,
  ScanSearch,
  SquareKanban,
  UserRound,
} from "./icons";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Card, COLUMN_LABELS, githubKey } from "../../../shared/board";
import {
  ACCOUNT_REASONS,
  type GithubFilter,
  type GithubItem,
  type GithubKind,
  type GithubList,
  type GithubProblem,
  type GithubProject,
  type GithubRepo,
  itemRef,
  refLabel,
  repoUrl,
} from "../../../shared/github";
import { formatStamp, relativeTime } from "../lib/format";
import { cardFromItem, githubProjects, imagesAsLinks, type ItemLook, itemLook, labelColor, linkableCards, linkedCards } from "../lib/github";
import { applyBoard, type PageState, remoteError, reviewPullRequest, showBoard, showPage, toast, useApp } from "../state/app";
import { ColumnIcon } from "./ColumnIcon";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Markdown } from "./Markdown";
import { useNow } from "./primitives";
import { ProjectSwitch } from "./ProjectSwitch";
import { COLLAPSED_INSET } from "./Sidebar";

type At = { x: number; y: number };
type Menu = { item: GithubItem; at: At; link?: boolean } | { accounts: true; at: At };
type ListKey = `${GithubKind}:${GithubFilter}`;
type Lists = Partial<Record<ListKey, GithubList | "loading">>;

const KINDS: { kind: GithubKind; label: string }[] = [
  { kind: "issue", label: "Issues" },
  { kind: "pr", label: "Pull requests" },
];
const FILTERS: GithubFilter[] = ["open", "closed"];
const REVIEW_HINT = "A new chat reviews it with the pr-review skill";

/** Keyed by project (App), so another project starts over on its open issues. */
export function GithubPage({ page }: { page: PageState }) {
  const board = useApp((state) => state.board);
  const projects = useApp((state) => state.projects);
  const inset = useApp((state) => state.sidebar.collapsed);
  useNow(60_000); // relative times
  const [project, setProject] = useState<GithubProject>();
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<GithubKind>("issue");
  const [filter, setFilter] = useState<GithubFilter>("open");
  const [lists, setLists] = useState<Lists>({});
  const [expanded, setExpanded] = useState<string>();
  const [menu, setMenu] = useState<Menu>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const switchable = useMemo(() => githubProjects(projects, page.cwd), [projects, page.cwd]);
  const linked = useMemo(() => linkedCards(board), [board]);
  // Answers from before a refresh or another account are dropped.
  const generation = useRef(0);

  /** Ask main for the repository and account again (refresh: gh's accounts too; chosen: use that account), then the lists. */
  const start = useCallback(
    (refresh: boolean, chosen?: string | null) => {
      const current = ++generation.current;
      setLoading(true);
      setLists({});
      const asked = chosen === undefined ? window.studio.github.project(page.cwd, refresh) : window.studio.github.choose(page.cwd, chosen);
      void asked
        .catch((error: unknown): GithubProject => ({ accounts: [], problem: { kind: "failed", message: remoteError(error) } }))
        .then((next) => {
          if (current !== generation.current) return;
          setProject(next);
          setLoading(false);
        });
    },
    [page.cwd],
  );

  useEffect(() => {
    start(false);
    return () => {
      generation.current++; // unmounted
    };
  }, [start]);

  const repo = !loading && project?.repo && !project.problem ? project.repo : undefined;

  // Both kinds of the filter shown, for the counts on the tabs; each once until a refresh.
  useEffect(() => {
    if (!repo) return;
    for (const which of KINDS.map((tab) => tab.kind)) {
      const key: ListKey = `${which}:${filter}`;
      if (lists[key]) continue;
      const current = generation.current;
      setLists((before) => ({ ...before, [key]: "loading" }));
      void window.studio.github
        .list(page.cwd, which, filter)
        .catch((error: unknown): GithubList => ({ problem: { kind: "failed", message: remoteError(error) } }))
        .then((list) => {
          if (current === generation.current) setLists((before) => ({ ...before, [key]: list }));
        });
    }
  }, [repo, filter, lists, page.cwd]);

  const shown = lists[`${kind}:${filter}`];
  const busy = loading || shown === "loading";
  const count = (which: GithubKind) => {
    const list = lists[`${which}:${filter}`];
    return list && list !== "loading" && !list.problem ? `${list.items.length}${list.more ? "+" : ""}` : "";
  };

  const newCard = async (item: GithubItem) => {
    if (!repo) return;
    const op = cardFromItem(page.cwd, repo, item);
    if (await applyBoard(op)) toast(`Added “${op.title}” to To do`);
  };
  const review = (item: GithubItem) => repo && reviewPullRequest(page.cwd, repo, item, project?.account?.login);
  const link = async (card: Card, item: GithubItem) => {
    if (repo && (await applyBoard({ type: "link", id: card.id, github: itemRef(repo, item) }))) toast(`Linked ${refLabel(item)} to “${card.title}”`);
  };

  const itemMenu = (item: GithubItem, at: At, linking?: boolean): MenuItem[][] => {
    if (!repo) return [];
    const ref = itemRef(repo, item);
    if (linking) {
      const cards = linkableCards(board, page.cwd, ref);
      if (!cards.length) return [[{ label: "No open card to link it to: make one", icon: <Plus size={13} />, onSelect: () => void newCard(item) }]];
      return [cards.map((card) => ({ label: card.title, icon: <ColumnIcon column={card.column} />, hint: COLUMN_LABELS[card.column], onSelect: () => void link(card, item) }))];
    }
    const cards = linked.get(githubKey(ref)) ?? [];
    return [
      [
        { label: "Open on GitHub", icon: <ExternalLink size={13} />, onSelect: () => window.studio.openExternal(item.url) },
        { label: "Copy link", icon: <Link2 size={13} />, onSelect: () => void navigator.clipboard.writeText(item.url) },
      ],
      cards.slice(0, 3).map((card) => ({ label: `Open “${card.title}”`, icon: <SquareKanban size={13} />, onSelect: () => showBoard(card.cwd, card.id) })),
      [
        ...(item.kind === "pr" ? [{ label: "Review in a new chat", icon: <ScanSearch size={13} />, hint: REVIEW_HINT, onSelect: () => review(item) }] : []),
        { label: "New card from it", icon: <Plus size={13} />, hint: "A To do card linked to it", onSelect: () => void newCard(item) },
        { label: "Link to card…", icon: <Link2 size={13} />, onSelect: () => setMenu({ item, at, link: true }) },
      ],
    ];
  };

  const accountMenu = (current: GithubProject): MenuItem[][] => {
    const blank = <span />;
    const auto = !current.chosen && current.account ? `Automatic: ${current.account.login}` : "Automatic";
    return [
      [{ label: auto, icon: current.chosen ? blank : <Check size={13} />, hint: "The account that can read the repository", onSelect: () => start(false, null) }],
      current.accounts.map((login) => ({
        label: login,
        icon: current.chosen === login ? <Check size={13} /> : blank,
        hint: `Always use ${login} for this project`,
        onSelect: () => start(false, login),
      })),
    ];
  };

  const problem = project?.problem ?? (shown && shown !== "loading" ? shown.problem : undefined);
  const listed = shown && shown !== "loading" && !shown.problem ? shown : undefined;

  return (
    <div className="page-enter flex h-full min-w-0 flex-col">
      <header className="drag dashed-b titlebar flex shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <GitPullRequest size={15} className="text-muted" />
        <span className="text-[13.5px] font-medium text-fg">GitHub</span>
        <ProjectSwitch cwd={page.cwd} options={switchable} openTitle="" onPick={(cwd) => showPage("github", cwd)} />
        <div className="flex-1" />
        <div className="no-drag flex items-center gap-0.5 rounded-lg border border-line p-0.5">
          {KINDS.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              aria-pressed={kind === tab.kind}
              onClick={() => setKind(tab.kind)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12.5px] ${kind === tab.kind ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
            >
              {tab.label}
              <span className="font-mono text-[11px] text-faint">{count(tab.kind)}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <div className="flex min-h-7 items-center gap-1">
            {FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                disabled={!repo}
                onClick={() => setFilter(option)}
                className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] capitalize disabled:opacity-40 ${filter === option ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
              >
                {option === "open" ? <CircleDot size={13} /> : <Check size={13} />}
                {option}
              </button>
            ))}
            <div className="flex-1" />
            {project?.repo && (
              <button
                type="button"
                title={`Open ${project.repo.repo} on ${project.repo.host}`}
                onClick={() => project.repo && window.studio.openExternal(repoUrl(project.repo))}
                className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 font-mono text-[11.5px] text-faint hover:bg-raised hover:text-fg"
              >
                <span className="truncate">{project.repo.repo}</span>
                <ExternalLink size={11} className="shrink-0" />
              </button>
            )}
            {project?.repo && project.accounts.length > 0 && (
              <button
                type="button"
                title={
                  project.account
                    ? `pi-gna reads ${project.repo.repo} as ${project.account.login}: ${ACCOUNT_REASONS[project.account.reason]}. Choose another account.`
                    : "Choose the account to read the repository as"
                }
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ accounts: true, at: { x: rect.left, y: rect.bottom + 4 } });
                }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg"
              >
                <UserRound size={12} className="text-faint" />
                {project.account?.login ?? project.chosen ?? "No account"}
                <ChevronDown size={12} className="text-faint" />
              </button>
            )}
            <button
              type="button"
              title="Refresh: ask GitHub again"
              disabled={loading}
              onClick={() => start(true)}
              className="rounded-lg p-1.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-60"
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            </button>
          </div>

          {problem ? (
            <ProblemView problem={problem} onRetry={() => start(true)} />
          ) : !repo || !listed ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-faint">Asking GitHub…</p>
          ) : listed.items.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-faint">
              No {filter} {kind === "pr" ? "pull requests" : "issues"} in {repo.repo}.
            </p>
          ) : (
            <>
              {listed.items.map((item) => (
                <ItemView
                  key={item.url}
                  item={item}
                  cards={linked.get(githubKey(itemRef(repo, item))) ?? []}
                  expanded={expanded === item.url}
                  onToggle={() => setExpanded(expanded === item.url ? undefined : item.url)}
                  onMenu={(at, linking) => setMenu({ item, at, link: linking })}
                  onNewCard={() => void newCard(item)}
                  onReview={() => review(item)}
                />
              ))}
              {listed.more && (
                <button
                  type="button"
                  onClick={() => window.studio.openExternal(`${repoUrl(repo)}/${kind === "pr" ? "pulls" : "issues"}?q=${encodeURIComponent(`is:${kind} is:${filter}`)}`)}
                  className="px-2 py-3 text-center text-[12px] text-faint hover:text-muted"
                >
                  The latest {listed.items.length}. See all of them on GitHub
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {menu && "accounts" in menu && project && <ContextMenu at={menu.at} sections={accountMenu(project)} onClose={closeMenu} />}
      {menu && "item" in menu && <ContextMenu at={menu.at} sections={itemMenu(menu.item, menu.at, menu.link)} onClose={closeMenu} />}
    </div>
  );
}

/** What is in the way, as main said it; `code` in it is set as code. */
function ProblemView({ problem, onRetry }: { problem: GithubProblem; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <GitPullRequest size={28} className="text-faint" />
      <p className="selectable max-w-md text-[12.5px] leading-relaxed text-muted">
        {problem.message.split("`").map((part, index) =>
          index % 2 ? (
            <code key={index} className="rounded bg-raised px-1 font-mono text-[11.5px] text-fg">
              {part}
            </code>
          ) : (
            part
          ),
        )}
      </p>
      {problem.kind !== "no-repo" && (
        <button type="button" onClick={onRetry} className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised">
          <RefreshCw size={13} className="text-muted" /> Try again
        </button>
      )}
    </div>
  );
}

const LOOKS: Record<ItemLook, { className: string; label: string }> = {
  open: { className: "text-ok", label: "Open" },
  draft: { className: "text-faint", label: "Draft" },
  closed: { className: "text-[#a371f7]", label: "Closed" },
  merged: { className: "text-[#a371f7]", label: "Merged" },
};

/** An issue or pull request's state, drawn as GitHub does. */
function StateIcon({ item, size = 15 }: { item: GithubItem; size?: number }) {
  const look = itemLook(item);
  // A closed pull request was not merged: red, as on GitHub.
  const className = item.kind === "pr" && look === "closed" ? "text-bad" : LOOKS[look].className;
  const Icon =
    item.kind === "issue"
      ? look === "open"
        ? CircleDot
        : CircleCheck
      : look === "merged"
        ? GitMerge
        : look === "closed"
          ? GitPullRequestClosed
          : look === "draft"
            ? GitPullRequestDraft
            : GitPullRequest;
  return (
    <span title={`${LOOKS[look].label} ${item.kind === "pr" ? "pull request" : "issue"}`} className={`shrink-0 ${className}`}>
      <Icon size={size} />
    </span>
  );
}

/** A card's link to an issue or pull request, which does not know its state. */
export function RefIcon({ kind, size = 11 }: { kind: GithubKind; size?: number }) {
  return kind === "pr" ? <GitPullRequest size={size} /> : <CircleDot size={size} />;
}

const REVIEWS: Record<NonNullable<GithubItem["review"]>, ReactNode> = {
  approved: <span className="text-ok">approved</span>,
  changes_requested: <span className="text-bad">changes requested</span>,
  review_required: <span>review required</span>,
};

function ItemView({
  item,
  cards,
  expanded,
  onToggle,
  onMenu,
  onNewCard,
  onReview,
}: {
  item: GithubItem;
  cards: Card[];
  expanded: boolean;
  onToggle: () => void;
  onMenu: (at: At, linking?: boolean) => void;
  onNewCard: () => void;
  onReview: () => void;
}) {
  // gh lists the newest first, so the row says when it was opened; when it last changed is in the tooltip.
  const created = Date.parse(item.createdAt);
  const updated = Date.parse(item.updatedAt);
  return (
    <article
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`rounded-xl border bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition-colors ${expanded ? "border-line-strong" : "border-line hover:border-line-strong"}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left + 12, y: rect.bottom - 4 });
          }
        }}
        className="flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <span className="mt-px">
          <StateIcon item={item} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 text-[13.5px] leading-snug text-fg ${expanded ? "" : "line-clamp-2"}`}>{item.title}</span>
            {cards.length > 0 && (
              <span
                className="flex shrink-0 items-center gap-1 self-center rounded-full border border-line px-1.5 text-[10.5px] leading-4 text-muted"
                title={`On the board: ${cards.map((card) => card.title).join(", ")}`}
              >
                <SquareKanban size={10} />
                {cards.length}
              </span>
            )}
            {Number.isFinite(created) && (
              <span
                className="shrink-0 font-mono text-[10.5px] text-faint"
                title={`Opened ${formatStamp(created)}${Number.isFinite(updated) && updated !== created ? `, updated ${formatStamp(updated)}` : ""}`}
              >
                {relativeTime(created)}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-faint">
            <span className="font-mono text-[11px]">#{item.number}</span>
            <span>by {item.author}</span>
            {item.kind === "pr" && item.head && (
              <span className="max-w-64 truncate font-mono text-[11px]" title={`${item.head} into ${item.base ?? "the default branch"}`}>
                · {item.head} → {item.base}
              </span>
            )}
            {item.review && item.state === "open" && <span>· {REVIEWS[item.review]}</span>}
            {item.labels.map((label) => (
              <span key={label.name} className="flex items-center gap-1 rounded-full border border-line px-1.5 text-[10.5px] leading-4 text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-line-strong" style={{ background: labelColor(label.color) }} />
                {label.name}
              </span>
            ))}
          </div>
        </div>
        <ChevronRight size={14} className={`mt-1 shrink-0 text-faint transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && <ItemDetail item={item} cards={cards} onMenu={onMenu} onNewCard={onNewCard} onReview={onReview} />}
    </article>
  );
}

function ItemDetail({
  item,
  cards,
  onMenu,
  onNewCard,
  onReview,
}: {
  item: GithubItem;
  cards: Card[];
  onMenu: (at: At, linking?: boolean) => void;
  onNewCard: () => void;
  onReview: () => void;
}) {
  const created = Date.parse(item.createdAt);
  const button = "flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised";
  return (
    <div className="dashed-t px-3.5 pt-3 pb-3">
      <div className="pl-[30px]">
        {item.body.trim() ? (
          <div className="github-body text-fg/90">
            <Markdown text={imagesAsLinks(item.body)} />
          </div>
        ) : (
          <p className="text-[12.5px] text-faint">No description.</p>
        )}
        {cards.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
            On the board:
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => showBoard(card.cwd, card.id)}
                title={`${COLUMN_LABELS[card.column]} · open the card`}
                className="flex max-w-72 items-center gap-1.5 rounded-lg border border-line px-2 py-0.5 text-[12px] text-fg/90 hover:bg-raised"
              >
                <ColumnIcon column={card.column} size={11} />
                <span className="truncate">{card.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => window.studio.openExternal(item.url)} className={button}>
            <ExternalLink size={13} className="text-muted" /> Open on GitHub
          </button>
          {item.kind === "pr" && (
            <button type="button" onClick={onReview} title={REVIEW_HINT} className={button}>
              <ScanSearch size={13} className="text-muted" /> Review
            </button>
          )}
          <button type="button" onClick={onNewCard} title="A To do card linked to it" className={button}>
            <Plus size={13} className="text-muted" /> New card
          </button>
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu({ x: rect.left, y: rect.bottom + 4 }, true);
            }}
            className={button}
          >
            <Link2 size={13} className="text-muted" /> Link to card…
          </button>
          {Number.isFinite(created) && <span className="flex-1 pl-1 text-[11.5px] text-faint">Opened {formatStamp(created)}</span>}
        </div>
      </div>
    </div>
  );
}
