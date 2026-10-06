// The phone's GitHub page: one project's issues and pull requests as on the desktop (GitHub.tsx), read with gh on the
// Mac as the account that can see the repository; tokens never leave it. Loaded when the page opens and on Refresh.
// A row opens to its body; the actions sheet opens it on GitHub (in the phone's browser), copies the link, reviews a PR
// in a new chat on the Mac, makes a card of it or links it to one.
import { Check, ChevronRight, CircleCheck, CircleDot, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Link2, MoreHorizontal, Plus, RefreshCw, ScanSearch, SquareKanban, UserRound } from "../renderer/src/components/icons";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Card, COLUMN_LABELS, githubKey } from "../shared/board";
import { ACCOUNT_REASONS, type GithubFilter, type GithubItem, type GithubKind, type GithubList, type GithubProject, itemRef, refLabel, repoUrl } from "../shared/github";
import { ColumnIcon } from "../renderer/src/components/ColumnIcon";
import { Markdown } from "../renderer/src/components/Markdown";
import { formatStamp, relativeTime } from "../renderer/src/lib/format";
import { cardFromItem, imagesAsLinks, type ItemLook, itemLook, labelColor, linkableCards, linkedCards } from "../renderer/src/lib/github";
import { useStore } from "../renderer/src/lib/store";
import type { HostClient } from "./client/host-client";
import type { Route } from "./nav";
import { copy, Header } from "./Screens";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sheetRow = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-fg active:bg-raised";
const KINDS: { kind: GithubKind; label: string }[] = [
  { kind: "issue", label: "Issues" },
  { kind: "pr", label: "Pull requests" },
];
const FILTERS: GithubFilter[] = ["open", "closed"];
type ListKey = `${GithubKind}:${GithubFilter}`;
type Lists = Partial<Record<ListKey, GithubList | "loading">>;
type Sheeted = { item: GithubItem; link?: boolean } | "accounts";

const LOOKS: Record<ItemLook, string> = { open: "text-ok", draft: "text-faint", closed: "text-[#a371f7]", merged: "text-[#a371f7]" };

function StateIcon({ item }: { item: GithubItem }) {
  const look = itemLook(item);
  const className = item.kind === "pr" && look === "closed" ? "text-bad" : LOOKS[look];
  const Icon = item.kind === "issue" ? (look === "open" ? CircleDot : CircleCheck) : look === "merged" ? GitMerge : look === "closed" ? GitPullRequestClosed : look === "draft" ? GitPullRequestDraft : GitPullRequest;
  return (
    <span aria-label={`${look} ${item.kind === "pr" ? "pull request" : "issue"}`} className={`mt-0.5 shrink-0 ${className}`}>
      <Icon size={18} />
    </span>
  );
}

const REVIEWS: Record<NonNullable<GithubItem["review"]>, ReactNode> = {
  approved: <span className="text-ok">approved</span>,
  changes_requested: <span className="text-bad">changes requested</span>,
  review_required: <span>review required</span>,
};

export function GithubScreen({ client, cwd, push, back }: { client: HostClient; cwd: string; push: (route: Route) => void; back: () => void }) {
  const board = useStore(client.store, (s) => s.global.board);
  const [project, setProject] = useState<GithubProject>();
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<GithubKind>("issue");
  const [filter, setFilter] = useState<GithubFilter>("open");
  const [lists, setLists] = useState<Lists>({});
  const [expanded, setExpanded] = useState<string>();
  const [sheet, setSheet] = useState<Sheeted>();
  const linked = useMemo(() => (board ? linkedCards(board) : new Map<string, Card[]>()), [board]);
  // Answers from before a refresh or another account are dropped.
  const generation = useRef(0);

  /** Ask the Mac for the repository and account again (refresh: gh's accounts too; chosen: use that account), then the lists. */
  const start = useCallback(
    (refresh: boolean, chosen?: string | null) => {
      const current = ++generation.current;
      setLoading(true);
      setLists({});
      const asked = chosen === undefined ? client.call("github.project", { cwd, refresh }) : client.call("github.choose", { cwd, login: chosen });
      void asked
        .catch((error: unknown): GithubProject => ({ accounts: [], problem: { kind: "failed", message: message(error) } }))
        .then((next) => {
          if (current !== generation.current) return;
          setProject(next);
          setLoading(false);
        });
    },
    [client, cwd],
  );

  useEffect(() => {
    start(false);
    return () => {
      generation.current++;
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
      void client
        .call("github.list", { cwd, kind: which, filter })
        .catch((error: unknown): GithubList => ({ problem: { kind: "failed", message: message(error) } }))
        .then((list) => {
          if (current === generation.current) setLists((before) => ({ ...before, [key]: list }));
        });
    }
  }, [client, repo, filter, lists, cwd]);

  const shown = lists[`${kind}:${filter}`];
  const busy = loading || shown === "loading";
  const count = (which: GithubKind) => {
    const list = lists[`${which}:${filter}`];
    return list && list !== "loading" && !list.problem ? `${list.items.length}${list.more ? "+" : ""}` : "";
  };

  const newCard = async (item: GithubItem) => {
    if (!repo) return;
    const op = cardFromItem(cwd, repo, item);
    await client.call("board.apply", { op }).then(() => toast(`Added “${op.title}” to To do`), (e) => toast(message(e), "error"));
  };
  const review = (item: GithubItem) => {
    if (!repo) return;
    client.call("chat.startTask", { target: { kind: "review", cwd, repo, item, login: project?.account?.login } }).then(
      (started) => {
        for (const notice of started.notices) toast(notice.text, notice.level);
        push({ screen: "chat", cwd, handle: started.handle, title: `Review: ${refLabel(item)}` });
      },
      (e) => toast(message(e), "error"),
    );
  };
  const link = (card: Card, item: GithubItem) => {
    if (!repo) return;
    client.call("board.apply", { op: { type: "link", id: card.id, github: itemRef(repo, item) } }).then(
      () => toast(`Linked ${refLabel(item)} to “${card.title}”`),
      (e) => toast(message(e), "error"),
    );
  };
  const openCard = (card: Card) => push({ screen: "page", page: "board", cwd: card.cwd, cardId: card.id });
  const openOnGithub = (url: string) => window.open(url, "_blank", "noopener");
  const pick = (action: () => void) => () => {
    setSheet(undefined);
    action();
  };

  const problem = project?.problem ?? (shown && shown !== "loading" ? shown.problem : undefined);
  const listed = shown && shown !== "loading" && !shown.problem ? shown : undefined;
  const sheetItem = sheet && sheet !== "accounts" ? sheet : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="github-screen">
      <Header
        title="GitHub"
        subtitle={project?.repo?.repo ?? cwd.split("/").filter(Boolean).at(-1)}
        onBack={back}
        trailing={
          <button type="button" aria-label="Refresh" disabled={loading} onClick={() => start(true)} className="grid h-11 w-11 shrink-0 place-items-center text-muted disabled:opacity-60" data-testid="github-refresh">
            <RefreshCw size={17} className={busy ? "animate-spin" : ""} />
          </button>
        }
      />
      <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-line px-4 py-2">
        {KINDS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            aria-pressed={kind === tab.kind}
            onClick={() => setKind(tab.kind)}
            className={`flex min-h-10 shrink-0 items-center gap-2 rounded-full px-4 text-[14px] ${kind === tab.kind ? "bg-raised text-fg" : "text-muted"}`}
            data-testid={`tab-${tab.kind}`}
          >
            {tab.label}
            <span className="font-mono text-[11px] text-faint">{count(tab.kind)}</span>
          </button>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            disabled={!repo}
            onClick={() => setFilter(option)}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-[13.5px] capitalize disabled:opacity-40 ${filter === option ? "bg-raised text-fg" : "text-muted"}`}
            data-testid={`filter-${option}`}
          >
            {option === "open" ? <CircleDot size={14} /> : <Check size={14} />}
            {option}
          </button>
        ))}
        <div className="flex-1" />
        {project?.repo && project.accounts.length > 0 && (
          <button type="button" onClick={() => setSheet("accounts")} className="flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted" data-testid="github-account">
            <UserRound size={13} className="text-faint" />
            {project.account?.login ?? project.chosen ?? "No account"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        <div className="flex flex-col gap-2">
          {problem ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center" data-testid="github-problem">
              <GitPullRequest size={28} className="text-faint" />
              <p className="max-w-md text-[13.5px] leading-relaxed text-muted wrap-anywhere">
                {problem.message.split("`").map((part, index) =>
                  index % 2 ? (
                    <code key={index} className="rounded bg-raised px-1 font-mono text-[12px] text-fg">
                      {part}
                    </code>
                  ) : (
                    part
                  ),
                )}
              </p>
              {problem.kind !== "no-repo" && (
                <button type="button" onClick={() => start(true)} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong px-4 text-[14px] text-fg">
                  <RefreshCw size={14} className="text-muted" /> Try again
                </button>
              )}
            </div>
          ) : !repo || !listed ? (
            <p className="px-2 py-10 text-center text-[13.5px] text-faint">Asking GitHub…</p>
          ) : listed.items.length === 0 ? (
            <p className="px-2 py-10 text-center text-[13.5px] text-faint" data-testid="github-empty">
              No {filter} {kind === "pr" ? "pull requests" : "issues"} in {repo.repo}.
            </p>
          ) : (
            <>
              {listed.items.map((item) => {
                const cards = linked.get(githubKey(itemRef(repo, item))) ?? [];
                const isOpen = expanded === item.url;
                const created = Date.parse(item.createdAt);
                return (
                  <article key={item.url} className="rounded-xl border border-line bg-panel" data-testid="github-item">
                    <div className="flex items-start">
                      <button type="button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? undefined : item.url)} className="flex min-w-0 flex-1 items-start gap-3 rounded-xl px-3.5 py-3 text-left" data-testid="github-row">
                        <StateIcon item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className={`min-w-0 flex-1 text-[15px] leading-snug text-fg ${isOpen ? "" : "line-clamp-2"}`}>{item.title}</span>
                            {cards.length > 0 && (
                              <span className="flex shrink-0 items-center gap-1 self-center rounded-full border border-line px-1.5 text-[11px] leading-4 text-muted" aria-label={`On the board: ${cards.map((card) => card.title).join(", ")}`}>
                                <SquareKanban size={10} />
                                {cards.length}
                              </span>
                            )}
                            {Number.isFinite(created) && <span className="shrink-0 font-mono text-[11px] text-faint">{relativeTime(created)}</span>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-faint">
                            <span className="font-mono text-[11.5px]">#{item.number}</span>
                            <span>by {item.author}</span>
                            {item.kind === "pr" && item.head && (
                              <span className="max-w-full truncate font-mono text-[11.5px]">
                                · {item.head} → {item.base}
                              </span>
                            )}
                            {item.review && item.state === "open" && <span>· {REVIEWS[item.review]}</span>}
                            {item.labels.map((label) => (
                              <span key={label.name} className="flex items-center gap-1 rounded-full border border-line px-1.5 text-[11px] leading-4 text-muted">
                                <span className="h-1.5 w-1.5 rounded-full bg-line-strong" style={{ background: labelColor(label.color) }} />
                                {label.name}
                              </span>
                            ))}
                          </div>
                        </div>
                        <ChevronRight size={15} className={`mt-1 shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      </button>
                      <button type="button" aria-label="Actions" onClick={() => setSheet({ item })} className="grid h-12 w-11 shrink-0 place-items-center text-muted" data-testid="github-actions">
                        <MoreHorizontal size={18} />
                      </button>
                    </div>
                    {isOpen && (
                      <div className="border-t border-line px-3.5 py-3" data-testid="github-detail">
                        {item.body.trim() ? (
                          <div className="github-body text-fg/90">
                            <Markdown text={imagesAsLinks(item.body)} />
                          </div>
                        ) : (
                          <p className="text-[13px] text-faint">No description.</p>
                        )}
                        {cards.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-faint">
                            On the board:
                            {cards.map((card) => (
                              <button key={card.id} type="button" onClick={() => openCard(card)} className="flex max-w-full min-h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] text-fg/90">
                                <ColumnIcon column={card.column} size={11} />
                                <span className="truncate">{card.title}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {Number.isFinite(created) && <div className="mt-3 text-[12px] text-faint">Opened {formatStamp(created)}</div>}
                      </div>
                    )}
                  </article>
                );
              })}
              {listed.more && (
                <button type="button" onClick={() => openOnGithub(`${repoUrl(repo)}/${kind === "pr" ? "pulls" : "issues"}?q=${encodeURIComponent(`is:${kind} is:${filter}`)}`)} className="px-2 py-3 text-center text-[12.5px] text-faint">
                  The latest {listed.items.length}. See all of them on GitHub
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {sheet === "accounts" && project && (
        <Sheet title="Read the repository as" onClose={() => setSheet(undefined)} testId="github-accounts-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {project.account && <p className="px-3 pb-2 text-[12.5px] text-faint">{project.account.login}: {ACCOUNT_REASONS[project.account.reason]}.</p>}
            <button type="button" className={sheetRow} onClick={pick(() => start(false, null))} data-testid="account-auto">
              {project.chosen ? <span className="w-[17px]" /> : <Check size={17} />}
              {!project.chosen && project.account ? `Automatic: ${project.account.login}` : "Automatic"}
            </button>
            {project.accounts.map((login) => (
              <button key={login} type="button" className={sheetRow} onClick={pick(() => start(false, login))} data-testid="account-choice">
                {project.chosen === login ? <Check size={17} /> : <span className="w-[17px]" />}
                {login}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {sheetItem && repo && (
        <Sheet title={sheetItem.link ? "Link to card" : `${refLabel(sheetItem.item)} · ${sheetItem.item.title.slice(0, 50)}`} onClose={() => setSheet(undefined)} testId="github-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {sheetItem.link ? (
              (() => {
                const cards = board ? linkableCards(board, cwd, itemRef(repo, sheetItem.item)) : [];
                return cards.length ? (
                  cards.map((card) => (
                    <button key={card.id} type="button" className={sheetRow} onClick={pick(() => link(card, sheetItem.item))} data-testid="link-card">
                      <ColumnIcon column={card.column} />
                      <span className="min-w-0 flex-1 truncate">{card.title}</span>
                      <span className="text-[12px] text-faint">{COLUMN_LABELS[card.column]}</span>
                    </button>
                  ))
                ) : (
                  <button type="button" className={sheetRow} onClick={pick(() => void newCard(sheetItem.item))}>
                    <Plus size={17} className="text-muted" /> No open card to link it to: make one
                  </button>
                );
              })()
            ) : (
              <>
                <button type="button" className={sheetRow} onClick={pick(() => openOnGithub(sheetItem.item.url))} data-testid="action-open">
                  <ExternalLink size={17} className="text-muted" /> Open on GitHub
                </button>
                <button type="button" className={sheetRow} onClick={pick(() => copy(sheetItem.item.url))} data-testid="action-copy">
                  <Link2 size={17} className="text-muted" /> Copy link
                </button>
                {sheetItem.item.kind === "pr" && (
                  <button type="button" className={sheetRow} onClick={pick(() => review(sheetItem.item))} data-testid="action-review">
                    <ScanSearch size={17} className="text-muted" /> Review in a new chat
                  </button>
                )}
                <button type="button" className={sheetRow} onClick={pick(() => void newCard(sheetItem.item))} data-testid="action-new-card">
                  <Plus size={17} className="text-muted" /> New card from it
                </button>
                <button type="button" className={sheetRow} onClick={() => setSheet({ item: sheetItem.item, link: true })} data-testid="action-link">
                  <Link2 size={17} className="text-muted" /> Link to card…
                </button>
              </>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
