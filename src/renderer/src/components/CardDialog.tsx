// A card's details (CardDetails): its title, tags and notes, its column, the chats it can start and the chats on it,
// and what they reported. They show in a native <dialog> on the board (CardDialog) and in a preview tab (CardTab).
// New cards are added on the board (AddCard), with their screenshots.
import { Check, ChevronDown, Link2, LoaderCircle, MessagesSquare, Trash2, Unlink, X } from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Card, COLUMN_LABELS, COLUMNS, githubKey, LIMITS } from "../../../shared/board";
import { refLabel } from "../../../shared/github";
import type { PickedPath } from "../../../shared/ipc";
import { chatSummary, chatTitle } from "../lib/board";
import { splitAttachments } from "../../../shared/task-prompts";
import { formatStamp, relativeTime } from "../lib/format";
import { attention } from "../../../shared/session-state";
import { applyBoard, boardRev, openSession, remoteError, sessionTitle, setOverlay, useApp, useFeature } from "../state/app";
import { cardActions } from "../state/card-actions";
import { ColumnIcon } from "./ColumnIcon";
import { RefIcon } from "./GitHub";
import { ContextMenu } from "./ContextMenu";
import { Indicator } from "./Sidebar";
import { Markdown } from "./Markdown";

export function CardDialog({ card, onClose }: { card: Card; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  /** A screenshot shown full size, inside the dialog: the app's lightbox would be under it (the top layer). */
  const [zoom, setZoom] = useState<string>();

  useEffect(() => {
    dialog.current?.showModal(); // focuses the first button
    setOverlay(true); // the native browser view would draw over the dialog
    return () => setOverlay(false);
  }, []);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={(event) => {
        if (!zoom) return;
        event.preventDefault(); // Esc closes the screenshot first
        setZoom(undefined);
      }}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close(); // the backdrop
      }}
      className="card-dialog m-auto max-h-[min(780px,calc(100vh-64px))] w-[min(640px,calc(100vw-48px))] overflow-hidden rounded-2xl border border-line-strong bg-panel p-0 text-fg shadow-[0_24px_80px_-24px_rgb(0_0_0/0.6)] backdrop:bg-black/45"
    >
      <CardDetails card={card} onClose={() => dialog.current?.close()} zoom={zoom} onZoom={setZoom} />
    </dialog>
  );
}

/** A card in a preview tab: the same details, filling the pane, so a chat link keeps the chat on screen. */
export function CardTab({ card, chat, onClose }: { card: Card; chat?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState<string>();
  return (
    <div className="h-full overflow-hidden bg-panel text-fg">
      <CardDetails card={card} chat={chat} onClose={onClose} zoom={zoom} onZoom={setZoom} />
    </div>
  );
}

/**
 * The card's fields and actions. `onClose` closes whatever holds them (the dialog, the tab); text edits are saved when
 * they unmount. Screenshots zoom through `zoom`, held by the owner so its Esc can close the zoom first. With `chat`, the
 * chat the card is shown beside, its tasks run there and a dropdown offers a new chat; without it they start a new chat.
 */
export function CardDetails({
  card,
  chat,
  onClose,
  zoom,
  onZoom,
}: {
  card: Card;
  chat?: string;
  onClose: () => void;
  zoom?: string;
  onZoom: (src: string | undefined) => void;
}) {
  const here = useApp((state) => (chat && state.sessions[chat]?.phase !== "exited" ? chat : undefined));
  const [elsewhere, setElsewhere] = useState<{ at: { x: number; y: number }; run: () => void }>();
  const sessions = useApp((state) => state.sessions);
  const projects = useApp((state) => state.projects);
  const github = useFeature("github");
  const tasks = useApp((state) => state.cardTasks[card.id]);
  const live = useMemo(() => Object.values(sessions), [sessions]);
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [deleting, setDeleting] = useState(false);
  // An agent can change the card while it is open: follow it, unless you are editing that field.
  const seen = useRef(card);
  // The board revision the title and notes on screen come from: text edits are checked against it, so an agent's
  // rename while you type is not overwritten silently.
  const editedFrom = useRef(boardRev());
  useEffect(() => {
    const previous = seen.current;
    seen.current = card;
    if (title === previous.title && notes === previous.notes) editedFrom.current = boardRev();
    setTitle((current) => (current === previous.title ? card.title : current));
    setNotes((current) => (current === previous.notes ? card.notes : current));
  }, [card]);

  useEffect(() => {
    if (!deleting) return;
    const timer = setTimeout(() => setDeleting(false), 4000);
    return () => clearTimeout(timer);
  }, [deleting]);

  const save = () => {
    const changed = (title.trim() && title !== card.title) || notes !== card.notes;
    if (!changed) return;
    void applyBoard({ type: "edit", id: card.id, title: title.trim() ? title : card.title, notes }, editedFrom.current).then(async (saved) => {
      // The revision our own save produced, so the next one is not a conflict with it. Refused (a conflict, usually;
      // applyBoard toasted): show what is saved instead of the text that was refused.
      const board = await window.studio.board.get().catch(() => undefined);
      if (!board) return;
      editedFrom.current = board.rev;
      const latest = board.cards.find((other) => other.id === card.id);
      if (!saved && latest) {
        setTitle(latest.title);
        setNotes(latest.notes);
      }
    });
  };
  const removed = useRef(false);
  const latestSave = useRef(save);
  latestSave.current = save;
  useEffect(() => () => {
    if (!removed.current) latestSave.current();
  }, []);
  const titleOf = (path: string) => chatTitle(path, card, projects, live, sessionTitle);

  return (
    <>
      {/* On the body: the tab or dialog around the details would clip and offset a fixed menu. */}
      {elsewhere &&
        createPortal(
          <ContextMenu
            at={elsewhere.at}
            sections={[[{ label: "On another chat", icon: <MessagesSquare size={13} />, hint: "A new chat takes it, in its own git worktree for Resolve", onSelect: elsewhere.run }]]}
            onClose={() => setElsewhere(undefined)}
          />,
          document.body,
        )}
      <div className="flex h-full max-h-[inherit] flex-col">
        <div className="flex items-center gap-1 px-4 pt-3.5">
          {COLUMNS.map((option) => {
            const current = card.column === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={current}
                onClick={() => void applyBoard({ type: "move", id: card.id, column: option })}
                className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] ${current ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
              >
                <ColumnIcon column={option} size={12} />
                {COLUMN_LABELS[option]}
              </button>
            );
          })}
          <div className="flex-1" />
          <span className="selectable font-mono text-[11px] text-faint">{card.id}</span>
          <button type="button" title="Close (Esc)" onClick={onClose} className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">
          <input
            value={title}
            maxLength={LIMITS.title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={save}
            placeholder="Card title"
            className="selectable w-full bg-transparent text-[17px] font-medium text-fg outline-none placeholder:text-faint"
          />
          <TagEditor card={card} />
          <textarea
            value={notes}
            maxLength={LIMITS.notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={save}
            placeholder="Notes: what needs doing, links, how to tell it is done"
            className="selectable mt-3 max-h-80 min-h-24 w-full resize-none rounded-xl border border-line bg-sunken px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none [field-sizing:content] placeholder:text-faint focus:border-line-strong"
          />
          <Screenshots notes={card.notes} onZoom={onZoom} />

          <div className="mt-3 flex flex-wrap gap-1.5">
            {cardActions(card).map((action) => {
              // A task the host is starting cannot be started again (a double click would start two chats).
              const phase = action.task && tasks?.[action.task];
              const runHere = here && action.runHere;
              return (
                <div key={action.id} className="flex">
                  <button
                    type="button"
                    title={runHere ? `${action.label} in this chat` : action.hint}
                    disabled={phase === "starting"}
                    aria-busy={phase === "starting" || undefined}
                    onClick={() => (runHere ? action.runHere?.(card, here) : action.run(card))}
                    className={`flex items-center gap-1.5 border px-2.5 py-1 text-[12.5px] ${runHere ? "rounded-l-lg" : "rounded-lg"} ${phase === "started" ? "border-ok/40 text-ok hover:bg-raised" : phase === "starting" ? "cursor-default border-line-strong text-muted" : "border-line-strong text-fg hover:bg-raised"}`}
                  >
                    {phase === "starting" ? (
                      <LoaderCircle size={13} className="animate-spin text-muted" />
                    ) : phase === "started" ? (
                      <Check size={13} />
                    ) : (
                      <action.icon size={13} className="text-muted" />
                    )}
                    {phase === "starting" ? `Starting ${action.label}…` : phase === "started" ? `${action.label} started` : action.label}
                  </button>
                  {runHere && (
                    <button
                      type="button"
                      title={`${action.label}: more ways`}
                      aria-haspopup="menu"
                      disabled={phase === "starting"}
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        setElsewhere({ at: { x: box.left, y: box.bottom + 4 }, run: () => action.run(card) });
                      }}
                      className="rounded-r-lg border border-l-0 border-line-strong px-1.5 text-muted hover:bg-raised hover:text-fg disabled:cursor-default"
                    >
                      <ChevronDown size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {github && <GithubLinks card={card} />}

          {card.chats.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-1.5 text-[12px] font-medium text-faint">Chats</h3>
              {[...card.chats].reverse().map((ref) => {
                const open = live.find((session) => session.sessionPath === ref.path);
                const level = open ? attention(open) : undefined;
                return (
                  <div key={ref.path} className="group flex items-center rounded-lg hover:bg-raised/60">
                    <button type="button" onClick={() => openSession(chatSummary(projects, ref))} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
                      <span className="grid w-3 shrink-0 place-items-center">
                        {level && level !== "idle" ? <Indicator level={level} /> : <MessagesSquare size={12} className="text-faint" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg/90">{titleOf(ref.path)}</span>
                      <span className="font-mono text-[10.5px] text-faint" title="Attached">
                        {relativeTime(ref.at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      title="Take this chat off the card"
                      onClick={() => void applyBoard({ type: "detach", id: card.id, path: ref.path })}
                      className="mr-1 rounded-md p-1 text-faint opacity-0 hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Unlink size={12} />
                    </button>
                  </div>
                );
              })}
            </section>
          )}

          {card.reports.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-[12px] font-medium text-faint">Reports</h3>
              <ol className="flex flex-col gap-3">
                {[...card.reports].reverse().map((report) => (
                  <li key={`${report.at}-${report.text.slice(0, 16)}`} className="flex gap-2.5">
                    <span className="mt-[3px] grid h-3 w-3 shrink-0 place-items-center self-start">
                      {report.column ? <ColumnIcon column={report.column} size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-faint">
                        <span>{formatStamp(report.at)}</span>
                        {report.column && <span>· moved to {COLUMN_LABELS[report.column]}</span>}
                        {report.chat && <span className="truncate">· {titleOf(report.chat)}</span>}
                      </div>
                      {report.text && (
                        <div className="card-report selectable mt-0.5 text-fg/90">
                          <Markdown text={report.text} />
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <footer className="dashed-t flex items-center gap-2 px-5 py-3">
          <span className="flex-1 text-[11.5px] text-faint">Created {formatStamp(card.createdAt)}</span>
          <button
            type="button"
            onClick={() => {
              if (!deleting) return setDeleting(true);
              void applyBoard({ type: "remove", id: card.id });
              removed.current = true;
              onClose();
            }}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] ${deleting ? "bg-bad/15 text-bad" : "text-faint hover:bg-raised hover:text-bad"}`}
          >
            <Trash2 size={13} />
            {deleting ? "Delete this card?" : "Delete"}
          </button>
        </footer>
      </div>
      {zoom && (
        <button type="button" onClick={() => onZoom(undefined)} className="fixed inset-0 z-10 grid cursor-zoom-out place-items-center bg-black/75 p-10">
          <img alt="" src={zoom} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </button>
      )}
    </>
  );
}


/** The images among the card's attachments (splitAttachments), read from disk; a file that is gone is left out. */
function Screenshots({ notes, onZoom }: { notes: string; onZoom: (src: string) => void }) {
  const paths = splitAttachments(notes).paths.join("\n");
  const [images, setImages] = useState<PickedPath[]>([]);
  useEffect(() => {
    let alive = true;
    void (paths ? window.studio.describePaths(paths.split("\n")) : Promise.resolve([])).then((described) => {
      if (alive) setImages(described.filter((item) => item.image));
    });
    return () => {
      alive = false;
    };
  }, [paths]);
  if (!images.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map(({ path, name, image }) => {
        const src = `data:${image?.mimeType};base64,${image?.data}`;
        return (
          <button key={path} type="button" title={path} onClick={() => onZoom(src)} className="block cursor-zoom-in">
            <img alt={name} src={src} className="h-16 max-w-40 rounded-lg border border-line object-cover" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The issues and pull requests the card is about: open one on GitHub, unlink it, or link another of the project's
 * repository by its number or link (main looks it up with gh, for its kind and title).
 */
function GithubLinks({ card }: { card: Card }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const link = async () => {
    const input = draft.trim();
    if (!input || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const found = await window.studio.github.lookup(card.cwd, input);
      if (found.problem) setError(found.problem.message);
      else if (await applyBoard({ type: "link", id: card.id, github: found.ref })) setDraft("");
    } catch (failure) {
      setError(remoteError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 text-[12px] font-medium text-faint">GitHub</h3>
      {card.github.map((ref) => (
        <div key={githubKey(ref)} className="group flex items-center rounded-lg hover:bg-raised/60">
          <button type="button" title={`Open ${ref.url}`} onClick={() => window.studio.openExternal(ref.url)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
            <span className="grid w-3 shrink-0 place-items-center text-faint">
              <RefIcon kind={ref.kind} size={12} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg/90">{ref.title || refLabel(ref)}</span>
            <span className="font-mono text-[10.5px] text-faint">
              {ref.repo}#{ref.number}
            </span>
          </button>
          <button
            type="button"
            title={`Unlink ${refLabel(ref)}`}
            onClick={() => void applyBoard({ type: "unlink", id: card.id, github: ref })}
            className="mr-1 rounded-md p-1 text-faint opacity-0 hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Unlink size={12} />
          </button>
        </div>
      ))}
      {card.github.length < LIMITS.github && (
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="grid w-3 shrink-0 place-items-center text-faint">{busy ? <LoaderCircle size={12} className="animate-spin" /> : <Link2 size={12} />}</span>
          <input
            value={draft}
            maxLength={500}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void link();
            }}
            placeholder="Link an issue or pull request: #12 or its link, then Enter"
            className="selectable min-w-0 flex-1 bg-transparent py-0.5 text-[12.5px] text-fg outline-none placeholder:text-faint"
          />
        </div>
      )}
      {error && <p className="selectable pl-7 text-[12px] leading-relaxed text-bad">{error}</p>}
    </section>
  );
}

/** The card's tags: type one and press Enter or comma; Backspace in the empty field takes the last off. */
function TagEditor({ card }: { card: Card }) {
  const [draft, setDraft] = useState("");
  const retag = (tags: string[]) => applyBoard({ type: "edit", id: card.id, tags });
  const add = async () => {
    if (draft.trim() && (await retag([...card.tags, draft]))) setDraft("");
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {card.tags.map((tag) => (
        <span key={tag} className="flex items-center gap-0.5 rounded-full border border-line py-px pr-0.5 pl-2 text-[11.5px] text-muted">
          {tag}
          <button type="button" title={`Remove ${tag}`} onClick={() => void retag(card.tags.filter((other) => other !== tag))} className="rounded-full p-0.5 text-faint hover:bg-raised hover:text-fg">
            <X size={10} />
          </button>
        </span>
      ))}
      {card.tags.length < LIMITS.tags && (
        <input
          value={draft}
          maxLength={LIMITS.tag}
          onChange={(event) => setDraft(event.target.value.replace(",", ""))}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              void add();
            } else if (event.key === "Backspace" && !draft && card.tags.length) void retag(card.tags.slice(0, -1));
          }}
          onBlur={() => void add()}
          placeholder={card.tags.length ? "Add tag" : "Add tags"}
          className="selectable w-24 bg-transparent py-0.5 text-[12px] text-fg outline-none placeholder:text-faint"
        />
      )}
    </div>
  );
}
