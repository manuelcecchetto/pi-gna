// The Kanban page: one project's board. Cards are tasks; chats attach to them, and agents move their card and
// report on it (kanban_* tools). Add a card by describing it; drag cards between columns; right-click one to
// start a chat on it.
import { Check, Ellipsis, LoaderCircle, MessagesSquare, Paperclip, Pencil, Plus, SquareKanban, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { type Card, COLUMN_LABELS, COLUMNS, type Column, githubKey } from "../../../shared/board";
import { refLabel } from "../../../shared/github";
import { boardColumns, boardProjects, cardAttention, cardSnippet, chatSummary, chatTitle } from "../lib/board";
import { splitAttachments } from "../../../shared/task-prompts";
import { baseName, relativeTime } from "../lib/format";
import { applyBoard, type CardTasks, openCard, openSession, type PageState, sessionTitle, showBoard, useApp, useFeature } from "../state/app";
import { cardActions } from "../state/card-actions";
import { CardDialog } from "./CardDialog";
import { ColumnIcon } from "./ColumnIcon";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { AddCard } from "./AddCard";
import { RefIcon } from "./GitHub";
import { useNow } from "./primitives";
import { ProjectSwitch } from "./ProjectSwitch";
import { COLLAPSED_INSET, Indicator } from "./Sidebar";

type Drop = { column: Column; before: string | null };
type Menu = { card: Card; at: { x: number; y: number }; confirmDelete?: boolean };

export function KanbanPage({ page }: { page: PageState }) {
  const board = useApp((state) => state.board);
  const sessions = useApp((state) => state.sessions);
  const projects = useApp((state) => state.projects);
  const tasks = useApp((state) => state.cardTasks);
  const inset = useApp((state) => state.sidebar.collapsed);
  useNow(60_000); // relative times
  const columns = useMemo(() => boardColumns(board, page.cwd), [board, page.cwd]);
  const live = useMemo(() => Object.values(sessions), [sessions]);
  const switchable = useMemo(() => boardProjects(board, projects, page.cwd), [board, projects, page.cwd]);
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<Drop>();
  const [menu, setMenu] = useState<Menu>();
  /** The column whose add-card input is open. */
  const [adding, setAdding] = useState<Column>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const open = page.card ? board.cards.find((card) => card.id === page.card) : undefined;
  const empty = COLUMNS.every((column) => columns[column].length === 0);

  const track = (event: React.DragEvent<HTMLElement>, column: Column) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const next = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-card]")].find((element) => {
      const rect = element.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    const before = next?.dataset.card ?? null;
    if (drop?.column !== column || drop.before !== before) setDrop({ column, before });
  };

  const dropOn = (column: Column) => {
    const id = dragging;
    setDragging(undefined);
    setDrop(undefined);
    if (!id || drop?.column !== column) return;
    const cards = columns[column];
    const index = cards.findIndex((card) => card.id === id);
    // Dropped where it already is.
    if (index >= 0 && (drop.before === id || drop.before === (cards[index + 1]?.id ?? null))) return;
    void applyBoard({ type: "move", id, column, before: drop.before });
  };

  const menuSections = (card: Card, confirmDelete?: boolean): MenuItem[][] => {
    if (confirmDelete) {
      return [
        [{ label: "Delete this card", icon: <Trash2 size={13} />, danger: true, onSelect: () => void applyBoard({ type: "remove", id: card.id }) }],
        [{ label: "Cancel", onSelect: () => undefined }],
      ];
    }
    const chats: MenuItem[] = card.chats
      .slice(-3)
      .reverse()
      .map((ref) => ({
        label: `Open “${chatTitle(ref.path, card, projects, live, sessionTitle)}”`,
        icon: <MessagesSquare size={13} />,
        onSelect: () => openSession(chatSummary(projects, ref)),
      }));
    const start: MenuItem[] = cardActions(card).map((action) => ({
      label: action.label,
      icon: <action.icon size={13} />,
      hint: action.hint,
      busy: action.task && tasks[card.id]?.[action.task] === "starting",
      onSelect: () => action.run(card),
    }));
    const moves: MenuItem[] = COLUMNS.filter((column) => column !== card.column).map((column) => ({
      label: `Move to ${COLUMN_LABELS[column]}`,
      icon: <ColumnIcon column={column} />,
      onSelect: () => void applyBoard({ type: "move", id: card.id, column }),
    }));
    const manage: MenuItem[] = [
      { label: "Edit…", icon: <Pencil size={13} />, onSelect: () => openCard(card.id) },
      // A second menu asks first: a card's notes and reports cannot be brought back.
      { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onSelect: () => setMenu({ card, at: { x: menu?.at.x ?? 0, y: menu?.at.y ?? 0 }, confirmDelete: true }) },
    ];
    return [chats, start, moves, manage];
  };

  return (
    <div className="page-enter flex h-full min-w-0 flex-col">
      <header className="drag dashed-b titlebar flex shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <SquareKanban size={15} className="text-muted" />
        <span className="text-[13.5px] font-medium text-fg">Kanban</span>
        <ProjectSwitch cwd={page.cwd} options={switchable} openTitle="Cards not done" onPick={(cwd) => showBoard(cwd)} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setAdding("todo")}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised"
        >
          <Plus size={13} /> New card
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pt-3 pb-4">
        {COLUMNS.map((column) => (
          <section key={column} className="flex w-0 min-w-[232px] flex-1 flex-col">
            <div className="group/column flex items-center gap-2 px-2 pb-2">
              <ColumnIcon column={column} />
              <span className="text-[12.5px] font-medium text-fg/90">{COLUMN_LABELS[column]}</span>
              <span className="font-mono text-[11px] text-faint">{columns[column].length}</span>
            </div>
            <div
              className={`flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-2xl bg-sunken/70 p-1.5 transition-shadow ${drop?.column === column ? "ring-1 ring-accent/40" : ""}`}
              // Both accept the card (the spec's drop target is the element that cancelled them), and both say where
              // it would land: above the first card whose middle is below the pointer.
              onDragEnter={(event) => track(event, column)}
              onDragOver={(event) => track(event, column)}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOn(column);
              }}
            >
              {columns[column].map((card) => (
                <div key={card.id} className="flex flex-col">
                  {drop?.column === column && drop.before === card.id && <DropLine />}
                  <CardView
                    card={card}
                    attention={cardAttention(card, live)}
                    dragging={dragging === card.id}
                    onDrag={setDragging}
                    onMenu={(at) => setMenu({ card, at })}
                  />
                </div>
              ))}
              {drop?.column === column && drop.before === null && <DropLine />}
              {empty && column === "todo" && (
                <p className="px-2 py-2 text-[12px] leading-relaxed text-faint">
                  Tasks for {baseName(page.cwd) || "this project"} go here. Right-click a card to have a chat investigate or resolve it, and QA it in review; chats can also take
                  cards and move them as they work.
                </p>
              )}
              <AddCard column={column} cwd={page.cwd} open={adding === column} onOpen={setAdding} />
            </div>
          </section>
        ))}
      </div>

      {menu && <ContextMenu at={menu.at} sections={menuSections(menu.card, menu.confirmDelete)} onClose={closeMenu} />}
      {open && <CardDialog key={open.id} card={open} onClose={() => openCard(undefined)} />}
    </div>
  );
}

/** A card's GitHub links shown as badges; the rest are counted. */
const GITHUB_BADGES = 3;

/** The card's tasks the host is starting (a spinner) or just started (a check): startCardTask. */
function CardTaskStatus({ card, tasks }: { card: Card; tasks: CardTasks }) {
  const shown = cardActions(card).filter((action) => action.task && tasks[action.task]);
  if (!shown.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1" aria-live="polite">
      {shown.map((action) =>
        action.task && tasks[action.task] === "starting" ? (
          <span key={action.id} className="flex items-center gap-1 rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-muted">
            <LoaderCircle size={11} className="animate-spin" />
            Starting {action.label}…
          </span>
        ) : (
          <span key={action.id} className="flex items-center gap-1 rounded-full bg-ok/10 px-1.5 text-[11px] leading-[18px] text-ok">
            <Check size={11} />
            {action.label} started
          </span>
        ),
      )}
    </div>
  );
}

function DropLine() {
  return <div className="mx-1 mb-1.5 h-0.5 rounded-full bg-accent" />;
}

function CardView({
  card,
  attention,
  dragging,
  onDrag,
  onMenu,
}: {
  card: Card;
  attention: ReturnType<typeof cardAttention>;
  dragging: boolean;
  onDrag: (id: string | undefined) => void;
  onMenu: (at: { x: number; y: number }) => void;
}) {
  const snippet = cardSnippet(card);
  const attached = splitAttachments(card.notes).paths.length;
  const github = useFeature("github") ? card.github : [];
  const tasks = useApp((state) => state.cardTasks[card.id]);
  return (
    <div
      data-card={card.id}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.title);
        onDrag(card.id);
      }}
      onDragEnd={() => onDrag(undefined)}
      onClick={() => openCard(card.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCard(card.id);
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({ x: rect.left + 12, y: rect.bottom - 4 });
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`group relative cursor-default rounded-xl border border-line bg-panel px-3 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.12)] outline-none transition-[border-color,opacity] hover:border-line-strong focus-visible:border-accent/60 ${dragging ? "opacity-40" : ""}`}
    >
      <div className="line-clamp-2 pr-5 text-[13px] leading-snug text-fg">{card.title}</div>
      {snippet && <div className="mt-1 truncate text-[12px] text-faint">{snippet}</div>}
      {tasks && <CardTaskStatus card={card} tasks={tasks} />}
      {card.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {card.tags.map((tag) => (
            <span key={tag} className="rounded-full border border-line px-1.5 text-[10.5px] leading-4 text-muted">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
        {attention && <Indicator level={attention} />}
        {card.chats.length > 0 && (
          <span className="flex items-center gap-1" title={`${card.chats.length} chat${card.chats.length === 1 ? "" : "s"} on this card`}>
            <MessagesSquare size={11} />
            {card.chats.length}
          </span>
        )}
        {attached > 0 && (
          <span className="flex items-center gap-1" title={`${attached} attachment${attached === 1 ? "" : "s"}`}>
            <Paperclip size={11} />
            {attached}
          </span>
        )}
        {github.slice(0, GITHUB_BADGES).map((ref) => (
          <button
            key={githubKey(ref)}
            type="button"
            title={`${refLabel(ref)} of ${ref.repo}${ref.title ? `: ${ref.title}` : ""}. Open on GitHub`}
            onClick={(event) => {
              event.stopPropagation();
              window.studio.openExternal(ref.url);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="flex items-center gap-0.5 rounded px-0.5 font-mono text-[10.5px] hover:bg-raised hover:text-fg"
          >
            <RefIcon kind={ref.kind} />
            {ref.number}
          </button>
        ))}
        {github.length > GITHUB_BADGES && <span title={`${github.length} GitHub links`}>+{github.length - GITHUB_BADGES}</span>}
        <span className="ml-auto font-mono text-[10.5px]" title="Last change">
          {relativeTime(card.updatedAt)}
        </span>
      </div>
      <button
        type="button"
        title="Card actions"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        className="absolute top-2 right-2 rounded-md p-0.5 text-faint opacity-0 hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Ellipsis size={14} />
      </button>
    </div>
  );
}

