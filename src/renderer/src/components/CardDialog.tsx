// A card's details in a native <dialog>: its title, tags and notes, its column, the chats it can start and the
// chats on it, and what they reported. New cards are added on the board (AddCard), with their screenshots.
import { Link2, LoaderCircle, MessagesSquare, Trash2, Unlink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Card, COLUMN_LABELS, COLUMNS, githubKey, LIMITS } from "../../../shared/board";
import { refLabel } from "../../../shared/github";
import type { PickedPath } from "../../../shared/ipc";
import { chatSummary, chatTitle, splitAttachments } from "../lib/board";
import { formatStamp, relativeTime } from "../lib/format";
import { attention } from "../lib/session";
import { applyBoard, openSession, remoteError, sessionTitle, setOverlay, useApp } from "../state/app";
import { cardActions } from "../state/card-actions";
import { ColumnIcon } from "./ColumnIcon";
import { RefIcon } from "./GitHub";
import { Indicator } from "./Sidebar";

export function CardDialog({ card, onClose }: { card: Card; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sessions = useApp((state) => state.sessions);
  const projects = useApp((state) => state.projects);
  const live = useMemo(() => Object.values(sessions), [sessions]);
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [deleting, setDeleting] = useState(false);
  /** A screenshot shown full size, inside the dialog: the app's lightbox would be under it (the top layer). */
  const [zoom, setZoom] = useState<string>();

  useEffect(() => {
    dialog.current?.showModal(); // focuses the first button
    setOverlay(true); // the native browser view would draw over the dialog
    return () => setOverlay(false);
  }, []);

  // An agent can change the card while it is open: follow it, unless you are editing that field.
  const seen = useRef(card);
  useEffect(() => {
    const previous = seen.current;
    seen.current = card;
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
    if (changed) void applyBoard({ type: "edit", id: card.id, title: title.trim() ? title : card.title, notes });
  };
  const close = () => {
    save();
    onClose();
  };
  const titleOf = (path: string) => chatTitle(path, card, projects, live, sessionTitle);

  return (
    <dialog
      ref={dialog}
      onClose={close}
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
      <div className="flex max-h-[inherit] flex-col">
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
          <button type="button" title="Close (Esc)" onClick={() => dialog.current?.close()} className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
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
          <Screenshots notes={card.notes} onZoom={setZoom} />

          <div className="mt-3 flex flex-wrap gap-1.5">
            {cardActions(card).map((action) => (
              <button
                key={action.id}
                type="button"
                title={action.hint}
                onClick={() => action.run(card)}
                className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised"
              >
                <action.icon size={13} className="text-muted" />
                {action.label}
              </button>
            ))}
          </div>

          <GithubLinks card={card} />

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
                      {report.text && <p className="selectable mt-0.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-fg/90">{report.text}</p>}
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
        <button type="button" onClick={() => setZoom(undefined)} className="fixed inset-0 z-10 grid cursor-zoom-out place-items-center bg-black/75 p-10">
          <img alt="" src={zoom} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </button>
      )}
    </dialog>
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
