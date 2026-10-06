// The phone's Kanban page: one project's board as the desktop's, columns as a segmented control with counts, a
// card's details in a page of its own, moves from a sheet or by long-press drag, new cards with photos, and the
// chats a card starts on the Mac. The host owns the board; every change is an op through board.apply.
import { ChevronDown, GripVertical, Image as ImageIcon, Link2, LoaderCircle, MessagesSquare, MoreHorizontal, Paperclip, Plus, Trash2, Unlink, X } from "../renderer/src/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { ColumnIcon } from "../renderer/src/components/ColumnIcon";
import { Markdown } from "../renderer/src/components/Markdown";
import { useChatActions } from "../renderer/src/lib/chat-ui";
import { boardColumns, boardProjects, cardSnippet, chatSummary } from "../renderer/src/lib/board";
import { baseName, formatStamp, relativeTime } from "../renderer/src/lib/format";
import { useStore } from "../renderer/src/lib/store";
import { type Board, type BoardOp, type Card, COLUMN_LABELS, COLUMNS, type Column, githubKey, LIMITS } from "../shared/board";
import { refLabel } from "../shared/github";
import type { NewCardAttachment } from "../shared/host-api";
import type { PickedPath } from "../shared/ipc";
import { splitAttachments } from "../shared/task-prompts";
import { attachmentCount, cardMark, cardTasks, type CardTask, dropOp, indexAt, moveToOp } from "./board-data";
import type { HostClient } from "./client/host-client";
import { useLongPress } from "./long-press";
import type { Route } from "./nav";
import { Header, Mark } from "./Screens";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isConflict = (error: unknown) => (error as { code?: string } | null)?.code === "conflict";
type Apply = (op: BoardOp, baseRev?: number) => Promise<number | undefined>;
const sheetRow = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] active:bg-raised";

export function BoardScreen({ client, cwd: initial, cardId, push, back }: { client: HostClient; cwd: string; cardId?: string; push: (route: Route) => void; back: () => void }) {
  const board = useStore(client.store, (s) => s.global.board);
  const projects = useStore(client.store, (s) => s.global.projects) ?? [];
  const attention = useStore(client.store, (s) => s.global.attention);
  const [cwd, setCwd] = useState(initial);
  const [column, setColumn] = useState<Column>(() => (cardId && board?.cards.find((card) => card.id === cardId)?.column) || "todo");
  const [open, setOpen] = useState<string | undefined>(cardId);
  const [menu, setMenu] = useState<string>();
  const [switcher, setSwitcher] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Card tasks the Mac is starting, as `card task`: a second tap does nothing until it answers. */
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const startingNow = useRef(new Set<string>());
  const columns = useMemo(() => (board ? boardColumns(board, cwd) : undefined), [board, cwd]);
  const current = open !== undefined ? board?.cards.find((card) => card.id === open) : undefined;
  const menuCard = menu !== undefined ? board?.cards.find((card) => card.id === menu) : undefined;

  /** One board op, answering the revision it produced; a conflict or a gone card toasts (undefined), and the board on screen is the host's anyway. */
  const apply: Apply = (op, baseRev) =>
    client.call("board.apply", { op, ...(baseRev !== undefined ? { baseRev } : {}) }).then(
      (board) => board.rev,
      (e) => {
        toast(isConflict(e) ? "The card changed on the Mac meanwhile; showing the latest." : message(e), "error");
        return undefined;
      },
    );
  const startTask = (card: Card, task: CardTask) => {
    if (task === "discuss") return push({ screen: "chat", cwd: card.cwd, cardId: card.id, title: card.title });
    const key = `${card.id} ${task}`;
    if (startingNow.current.has(key)) return;
    const track = (on: boolean) => {
      if (on) startingNow.current.add(key);
      else startingNow.current.delete(key);
      setStarting(new Set(startingNow.current));
    };
    track(true);
    client
      .call("chat.startTask", { target: { kind: task, card: card.id } })
      .then(
        (started) => {
          for (const notice of started.notices) toast(notice.text, notice.level);
          push({ screen: "chat", cwd: card.cwd, handle: started.handle, title: `${task === "qa" ? "QA" : task === "resolve" ? "Resolve" : "Investigate"}: ${card.title}` });
        },
        (e) => toast(message(e), "error"),
      )
      .finally(() => track(false));
  };

  const shown = columns?.[column] ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="board-screen">
      <Header
        title="Kanban board"
        subtitle={baseName(cwd)}
        onBack={back}
        trailing={
          <>
            <button type="button" aria-label="Switch project" onClick={() => setSwitcher(true)} className="grid h-11 w-11 place-items-center text-muted" data-testid="board-switcher">
              <ChevronDown size={20} />
            </button>
            <button type="button" aria-label="Add card" onClick={() => setAdding(true)} className="grid h-11 w-11 place-items-center text-accent" data-testid="add-card">
              <Plus size={22} />
            </button>
          </>
        }
      />
      <div className="flex shrink-0 justify-between border-b border-line px-2 py-2" role="tablist">
        {COLUMNS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={column === option}
            onClick={() => setColumn(option)}
            className={`flex min-h-10 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] ${column === option ? "bg-raised text-fg" : "text-muted"}`}
            data-testid={`column-${option}`}
          >
            <ColumnIcon column={option} size={13} />
            {COLUMN_LABELS[option]}
            <span className="font-mono text-[11px] text-faint" data-testid="column-count">{columns?.[option].length ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        {!columns && <div className="p-6 text-center text-[13.5px] text-faint">Loading…</div>}
        {columns && shown.length === 0 && (
          <p className="px-4 py-10 text-center text-[13.5px] leading-relaxed text-faint" data-testid="board-empty">
            {column === "todo" ? `Nothing to do in ${baseName(cwd)}. Add a card with +.` : `No cards in ${COLUMN_LABELS[column]}.`}
          </p>
        )}
        {columns && shown.length > 0 && (
          <CardList
            cards={shown}
            mark={(card) => cardMark(card, attention)}
            onOpen={(card) => setOpen(card.id)}
            onMenu={(card) => setMenu(card.id)}
            onDrop={(op) => void apply(op)}
          />
        )}
      </div>

      {menuCard && (
        <Sheet title={menuCard.title.slice(0, 60)} onClose={() => setMenu(undefined)} testId="card-menu">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="px-3 pt-1 pb-1 text-[12px] text-faint">Move to…</div>
            {COLUMNS.filter((option) => option !== menuCard.column).map((option) => (
              <button
                key={option}
                type="button"
                className={sheetRow}
                data-testid={`move-${option}`}
                onClick={() => {
                  setMenu(undefined);
                  const op = moveToOp(menuCard, option);
                  if (op) void apply(op);
                }}
              >
                <ColumnIcon column={option} size={15} />
                {COLUMN_LABELS[option]}
              </button>
            ))}
            {cardTasks(menuCard).map((task) => (
              <button key={task.id} type="button" className={sheetRow} data-testid={`task-${task.id}`} onClick={() => { setMenu(undefined); startTask(menuCard, task.id); }}>
                {task.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {switcher && board && (
        <Sheet title="Project board" onClose={() => setSwitcher(false)} testId="board-projects">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {boardProjects(board, projects, cwd).map((project) => (
              <button key={project.cwd} type="button" className={`${sheetRow} justify-between ${project.cwd === cwd ? "text-accent" : ""}`} onClick={() => { setSwitcher(false); setCwd(project.cwd); setOpen(undefined); }}>
                <span className="min-w-0 truncate">{baseName(project.cwd)}</span>
                <span className="font-mono text-[11px] text-faint">{project.open}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {adding && <AddCard client={client} cwd={cwd} onClose={() => setAdding(false)} />}
      {current && board && <CardPage key={current.id} client={client} board={board} card={current} apply={apply} startTask={startTask} starting={starting} push={push} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

/** A column's cards. A long press lifts a row: drag it up or down and let go to drop it there. */
function CardList({ cards, mark, onOpen, onMenu, onDrop }: { cards: Card[]; mark: (card: Card) => ReturnType<typeof cardMark>; onOpen: (card: Card) => void; onMenu: (card: Card) => void; onDrop: (op: BoardOp) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; index: number }>();
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  useEffect(() => {
    if (!drag) return;
    const index = (y: number) => {
      const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])].filter((row) => row.dataset.card !== dragRef.current?.id);
      return indexAt(rows.map((row) => row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2), y);
    };
    const move = (event: PointerEvent) => setDrag((d) => d && { ...d, index: index(event.clientY) });
    const stop = (apply: boolean) => () => {
      const d = dragRef.current;
      setDrag(undefined);
      const op = apply && d ? dropOp(cardsRef.current, d.id, d.index) : undefined;
      if (op) onDrop(op);
    };
    const up = stop(true);
    const cancel = stop(false);
    // The page must not scroll under the finger that drags a row.
    const block = (event: TouchEvent) => event.preventDefault();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    document.addEventListener("touchmove", block, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("touchmove", block);
    };
    // Re-bound per drag, not per move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id]);

  // The rows as they show during a drag: the lifted one at its drop place.
  const order = useMemo(() => {
    if (!drag) return cards;
    const lifted = cards.find((card) => card.id === drag.id);
    if (!lifted) return cards;
    const rest = cards.filter((card) => card !== lifted);
    rest.splice(Math.min(drag.index, rest.length), 0, lifted);
    return rest;
  }, [cards, drag]);

  return (
    <div ref={list} className="flex flex-col gap-2" data-testid="card-list">
      {order.map((card) => (
        <CardRow key={card.id} card={card} lifted={drag?.id === card.id} mark={mark(card)} onOpen={() => onOpen(card)} onMenu={() => onMenu(card)} onLift={() => setDrag({ id: card.id, index: cards.findIndex((c) => c.id === card.id) })} />
      ))}
    </div>
  );
}

function CardRow({ card, lifted, mark, onOpen, onMenu, onLift }: { card: Card; lifted: boolean; mark: ReturnType<typeof cardMark>; onOpen: () => void; onMenu: () => void; onLift: () => void }) {
  const press = useLongPress(onLift);
  const files = attachmentCount(card);
  const snippet = cardSnippet(card);
  return (
    <article data-card={card.id} className={`flex items-stretch rounded-xl border bg-panel ${lifted ? "border-accent shadow-lg" : "border-line"}`} data-testid="card">
      <button
        type="button"
        {...press}
        onClick={press.guard(onOpen)}
        className="min-w-0 flex-1 rounded-xl px-3.5 py-3 text-left select-none [-webkit-touch-callout:none]"
        data-testid="card-row"
      >
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-[15px] leading-snug text-fg">{card.title}</span>
          <Mark level={mark} />
        </div>
        {snippet && <div className="mt-0.5 line-clamp-2 text-[13px] text-faint">{snippet}</div>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
          {card.tags.map((tag) => (
            <span key={tag} className="rounded-full border border-line px-2 py-px">{tag}</span>
          ))}
          {card.github.map((ref) => (
            <span key={githubKey(ref)} className="rounded-full border border-line px-2 py-px font-mono" data-testid="github-badge">
              {ref.kind === "pr" ? "PR" : "#"}{ref.number}
            </span>
          ))}
          {files > 0 && (
            <span className="flex items-center gap-0.5" data-testid="attachment-count">
              <Paperclip size={11} />
              {files}
            </span>
          )}
          {card.chats.length > 0 && (
            <span className="flex items-center gap-0.5" data-testid="chat-count">
              <MessagesSquare size={11} />
              {card.chats.length}
            </span>
          )}
        </div>
      </button>
      <button type="button" aria-label="Card actions" onClick={onMenu} className="grid w-11 shrink-0 place-items-center text-muted" data-testid="card-actions">
        {lifted ? <GripVertical size={18} /> : <MoreHorizontal size={18} />}
      </button>
    </article>
  );
}

/** A card's details over the board: edits are checked against the revision they started from. */
function CardPage({ client, board, card, apply, startTask, starting, push, onClose }: { client: HostClient; board: Board & { rev: number }; card: Card; apply: Apply; startTask: (card: Card, task: CardTask) => void; starting: ReadonlySet<string>; push: (route: Route) => void; onClose: () => void }) {
  const projects = useStore(client.store, (s) => s.global.projects) ?? [];
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The revision the title and notes on screen come from; an agent's change while you type is not overwritten silently.
  const editedFrom = useRef(board.rev);
  const seen = useRef(card);
  useEffect(() => {
    const previous = seen.current;
    seen.current = card;
    if (title === previous.title && notes === previous.notes) editedFrom.current = board.rev;
    setTitle((now) => (now === previous.title ? card.title : now));
    setNotes((now) => (now === previous.notes ? card.notes : now));
    // Follows the host's card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);
  useEffect(() => {
    if (!deleting) return;
    const timer = setTimeout(() => setDeleting(false), 4000);
    return () => clearTimeout(timer);
  }, [deleting]);
  const latest = useRef(board.rev);
  latest.current = board.rev;

  const save = async () => {
    const changed = (title.trim() && title !== card.title) || notes !== card.notes;
    if (!changed) return;
    const rev = await apply({ type: "edit", id: card.id, title: title.trim() ? title : card.title, notes }, editedFrom.current);
    // The revision our own save produced, so the next one is not a conflict with it.
    if (rev !== undefined) editedFrom.current = rev;
    else {
      // Refused (a conflict, usually): show what the host has.
      setTitle(card.title);
      setNotes(card.notes);
      editedFrom.current = latest.current;
    }
  };
  const close = () => {
    void save();
    onClose();
  };
  const retag = (tags: string[]) => apply({ type: "edit", id: card.id, tags });
  const titleOf = (path: string) => chatSummary(projects, card.chats.find((ref) => ref.path === path) ?? { path, cwd: card.cwd, at: 0 }).title;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-canvas" data-testid="card-page">
      <Header title="Card" subtitle={card.id} onBack={close} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-8">
        <div className="flex gap-1 overflow-x-auto pb-2">
          {COLUMNS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={card.column === option}
              onClick={() => { const op = moveToOp(card, option); if (op) void apply(op); }}
              className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] ${card.column === option ? "bg-raised text-fg" : "text-muted"}`}
              data-testid={`card-column-${option}`}
            >
              <ColumnIcon column={option} size={12} />
              {COLUMN_LABELS[option]}
            </button>
          ))}
        </div>
        <input
          value={title}
          maxLength={LIMITS.title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void save()}
          placeholder="Card title"
          className="w-full bg-transparent text-[18px] font-medium text-fg outline-none placeholder:text-faint"
          data-testid="card-title"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {card.tags.map((tag) => (
            <span key={tag} className="flex items-center gap-1 rounded-full border border-line py-0.5 pr-1 pl-2.5 text-[12.5px] text-muted" data-testid="card-tag">
              {tag}
              <button type="button" aria-label={`Remove ${tag}`} onClick={() => void retag(card.tags.filter((other) => other !== tag))} className="grid h-6 w-6 place-items-center text-faint">
                <X size={11} />
              </button>
            </span>
          ))}
          {card.tags.length < LIMITS.tags && <TagInput onAdd={(tag) => retag([...card.tags, tag])} />}
        </div>

        <div className="mt-3">
          {editing ? (
            <textarea
              value={notes}
              maxLength={LIMITS.notes}
              autoFocus
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => { setEditing(false); void save(); }}
              placeholder="Notes: what needs doing, links, how to tell it is done"
              className="min-h-40 w-full resize-none rounded-xl border border-line bg-sunken px-3 py-2.5 text-[16px] leading-relaxed text-fg outline-none [field-sizing:content] placeholder:text-faint"
              data-testid="card-notes-edit"
            />
          ) : (
            <button type="button" onClick={() => setEditing(true)} className="block min-h-16 w-full rounded-xl border border-line bg-panel px-3 py-2.5 text-left text-[14px]" data-testid="card-notes">
              {splitAttachments(notes).text.trim() ? <Markdown text={splitAttachments(notes).text} /> : <span className="text-faint">Add notes</span>}
            </button>
          )}
        </div>
        <Screenshots client={client} notes={card.notes} />

        <div className="mt-4 flex flex-wrap gap-2">
          {cardTasks(card).map((task) => {
            const busy = starting.has(`${card.id} ${task.id}`);
            return (
              <button
                key={task.id}
                type="button"
                title={task.hint}
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => { void save(); startTask(card, task.id); }}
                className={`flex min-h-10 items-center gap-1.5 rounded-xl border border-line-strong px-3.5 text-[14px] active:bg-raised ${busy ? "text-muted" : "text-fg"}`}
                data-testid={`card-task-${task.id}`}
              >
                {busy && <LoaderCircle size={15} className="animate-spin" />}
                {busy ? `Starting ${task.label}…` : task.label}
              </button>
            );
          })}
        </div>

        <GithubLinks client={client} card={card} apply={apply} />

        {card.chats.length > 0 && (
          <section className="mt-6" data-testid="card-chats">
            <h3 className="mb-1 text-[12px] font-medium text-faint">Chats</h3>
            {[...card.chats].reverse().map((ref) => (
              <div key={ref.path} className="flex items-center">
                <button type="button" onClick={() => push({ screen: "chat", cwd: ref.cwd, sessionPath: ref.path, title: titleOf(ref.path) })} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 text-left" data-testid="card-chat">
                  <MessagesSquare size={14} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[14.5px] text-fg">{titleOf(ref.path)}</span>
                  <span className="font-mono text-[11px] text-faint">{relativeTime(ref.at)}</span>
                </button>
                <button type="button" aria-label="Take this chat off the card" onClick={() => void apply({ type: "detach", id: card.id, path: ref.path })} className="grid h-12 w-11 place-items-center text-faint">
                  <Unlink size={14} />
                </button>
              </div>
            ))}
          </section>
        )}

        {card.reports.length > 0 && (
          <section className="mt-6" data-testid="card-reports">
            <h3 className="mb-2 text-[12px] font-medium text-faint">Reports</h3>
            <ol className="flex flex-col gap-3.5">
              {[...card.reports].reverse().map((report) => (
                <li key={`${report.at}-${report.text.slice(0, 16)}`} className="flex gap-2.5">
                  <span className="mt-1 grid h-3 w-3 shrink-0 place-items-center">{report.column ? <ColumnIcon column={report.column} size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-x-1.5 text-[12px] text-faint">
                      <span>{formatStamp(report.at)}</span>
                      {report.column && <span>· moved to {COLUMN_LABELS[report.column]}</span>}
                      {report.chat && <span className="truncate">· {titleOf(report.chat)}</span>}
                    </div>
                    {report.text && (
                      <div className="card-report mt-0.5 text-fg/90">
                        <Markdown text={report.text} />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        <div className="mt-8 flex items-center gap-3">
          <span className="flex-1 text-[12px] text-faint">Created {formatStamp(card.createdAt)}</span>
          <button
            type="button"
            onClick={() => {
              if (!deleting) return setDeleting(true);
              void apply({ type: "remove", id: card.id });
              onClose();
            }}
            className={`flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[13.5px] ${deleting ? "bg-bad/15 text-bad" : "text-muted"}`}
            data-testid="card-delete"
          >
            <Trash2 size={14} />
            {deleting ? "Delete this card?" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TagInput({ onAdd }: { onAdd: (tag: string) => Promise<number | undefined> }) {
  const [draft, setDraft] = useState("");
  const add = async () => {
    if (draft.trim() && (await onAdd(draft)) !== undefined) setDraft("");
  };
  return (
    <input
      value={draft}
      maxLength={LIMITS.tag}
      onChange={(event) => setDraft(event.target.value.replace(",", ""))}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          void add();
        }
      }}
      onBlur={() => void add()}
      placeholder="Add tag"
      autoCapitalize="none"
      className="w-24 bg-transparent py-1 text-[16px] text-fg outline-none placeholder:text-faint"
      data-testid="tag-input"
    />
  );
}

/** The images among the card's attachments, read on the Mac; a file that is gone is left out. */
function Screenshots({ client, notes }: { client: HostClient; notes: string }) {
  const actions = useChatActions();
  const paths = splitAttachments(notes).paths.join("\n");
  const [images, setImages] = useState<PickedPath[]>([]);
  useEffect(() => {
    let alive = true;
    if (!paths) return setImages([]);
    client.call("fs.describePaths", { paths: paths.split("\n") }).then(
      (described) => alive && setImages(described.filter((item) => item.image)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, paths]);
  if (!images.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="card-images">
      {images.map(({ path, name, image }) => {
        const src = `data:${image?.mimeType};base64,${image?.data}`;
        return (
          <button key={path} type="button" onClick={() => actions.openLightbox(src)} className="block">
            <img alt={name} src={src} className="h-20 max-w-44 rounded-lg border border-line object-cover" />
          </button>
        );
      })}
    </div>
  );
}

/** The issues and pull requests the card is about: open one, unlink it, or link another by number or link (the Mac looks it up with gh). */
function GithubLinks({ client, card, apply }: { client: HostClient; card: Card; apply: Apply }) {
  const feature = useStore(client.store, (s) => s.global.settings?.features.github);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!feature) return null;
  const link = async () => {
    const input = draft.trim();
    if (!input || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const found = await client.call("github.lookup", { cwd: card.cwd, input });
      if (found.problem) setError(found.problem.message);
      else if ((await apply({ type: "link", id: card.id, github: found.ref })) !== undefined) setDraft("");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-6" data-testid="card-github">
      <h3 className="mb-1 text-[12px] font-medium text-faint">GitHub</h3>
      {card.github.map((ref) => (
        <div key={githubKey(ref)} className="flex items-center">
          <a href={ref.url} target="_blank" rel="noreferrer" className="flex min-h-12 min-w-0 flex-1 items-center gap-2 text-[14.5px] text-fg" data-testid="card-github-ref">
            <span className="min-w-0 flex-1 truncate">{ref.title || refLabel(ref)}</span>
            <span className="font-mono text-[11px] text-faint">{ref.repo}#{ref.number}</span>
          </a>
          <button type="button" aria-label={`Unlink ${refLabel(ref)}`} onClick={() => void apply({ type: "unlink", id: card.id, github: ref })} className="grid h-12 w-11 place-items-center text-faint" data-testid="unlink">
            <Unlink size={14} />
          </button>
        </div>
      ))}
      {card.github.length < LIMITS.github && (
        <div className="flex items-center gap-2 py-1">
          {busy ? <LoaderCircle size={14} className="animate-spin text-faint" /> : <Link2 size={14} className="text-faint" />}
          <input
            value={draft}
            maxLength={500}
            onChange={(event) => { setDraft(event.target.value); setError(undefined); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void link(); } }}
            enterKeyHint="go"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="Link an issue or PR: #12 or its link"
            className="min-w-0 flex-1 bg-transparent py-2 text-[16px] text-fg outline-none placeholder:text-faint"
            data-testid="link-input"
          />
        </div>
      )}
      {error && <p className="text-[12.5px] leading-relaxed text-bad" data-testid="link-error">{error}</p>}
    </section>
  );
}

type Photo = { id: number; name: string; state: "uploading" | "ready" | "error"; path?: string; url: string; error?: string };

/** A new card: a description and photos; the Mac adds it to To do and starts its triage chat. */
function AddCard({ client, cwd, onClose }: { client: HostClient; cwd: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const next = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const ready = photos.every((photo) => photo.state !== "uploading");
  const usable = photos.filter((photo): photo is Photo & { path: string } => photo.state === "ready" && photo.path !== undefined);
  const canAdd = (text.trim() !== "" || usable.length > 0) && ready && !busy;

  useEffect(() => () => photos.forEach((photo) => URL.revokeObjectURL(photo.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const id = next.current++;
      const photo: Photo = { id, name: file.name || `photo-${id}.jpg`, state: "uploading", url: URL.createObjectURL(file) };
      setPhotos((list) => [...list, photo]);
      client.upload(file, photo.name).then(
        (done) => setPhotos((list) => list.map((p) => (p.id === id ? { ...p, state: "ready", path: done.path } : p))),
        (e) => setPhotos((list) => list.map((p) => (p.id === id ? { ...p, state: "error", error: message(e) } : p))),
      );
    }
    if (input.current) input.current.value = "";
  };
  const submit = async () => {
    if (!canAdd) return;
    setBusy(true);
    const attachments: NewCardAttachment[] = usable.map((photo) => ({ kind: "file", path: photo.path }));
    try {
      await client.call("board.addCard", { cwd, column: "todo", description: text.trim(), ...(attachments.length ? { attachments } : {}) });
      toast("Card added; a chat is triaging it");
      onClose();
    } catch (e) {
      toast(message(e), "error");
      setBusy(false);
    }
  };
  return (
    <Sheet title="New card" onClose={onClose} testId="add-card-sheet">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
        <textarea
          value={text}
          autoFocus
          maxLength={LIMITS.notes}
          onChange={(event) => setText(event.target.value)}
          placeholder="Describe what needs doing"
          className="min-h-28 w-full resize-none rounded-xl bg-sunken px-3 py-2.5 text-[16px] leading-relaxed text-fg outline-none placeholder:text-faint"
          data-testid="add-card-text"
        />
        <div className="flex flex-wrap gap-2">
          {photos.map((photo) => (
            <div key={photo.id} className="relative" data-testid="add-card-photo" data-state={photo.state}>
              <img alt={photo.name} src={photo.url} className={`h-16 w-16 rounded-lg border object-cover ${photo.state === "error" ? "border-bad" : "border-line"} ${photo.state === "uploading" ? "opacity-50" : ""}`} />
              <button type="button" aria-label={`Remove ${photo.name}`} onClick={() => setPhotos((list) => list.filter((p) => p.id !== photo.id))} className="absolute -top-2 -right-2 grid h-6 w-6 place-items-center rounded-full bg-raised text-fg">
                <X size={12} />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => input.current?.click()} className="grid h-16 w-16 place-items-center rounded-lg border border-dashed border-line-strong text-muted" aria-label="Add photos" data-testid="add-card-photos">
            <ImageIcon size={20} />
          </button>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(event) => pick(event.target.files)} data-testid="add-card-file" />
        </div>
        {photos.some((photo) => photo.state === "error") && <p className="text-[12.5px] text-bad">{photos.find((photo) => photo.state === "error")?.error}</p>}
        <button type="button" disabled={!canAdd} onClick={() => void submit()} className="min-h-12 rounded-xl bg-accent text-[15px] font-medium text-white disabled:opacity-40" data-testid="add-card-submit">
          {busy ? "Adding…" : "Add card"}
        </button>
        <p className="text-[12px] text-faint">The card goes to To do and a chat on the Mac triages it: a title, tags and a first look.</p>
      </div>
    </Sheet>
  );
}
