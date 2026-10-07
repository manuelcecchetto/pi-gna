import { ArrowUp, Brain, ChevronDown, Cpu, FileText, Folder, MessageSquare, Plus, Square, SquareKanban, X } from "./icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Card, COLUMN_LABELS } from "../../../shared/board";
import type { Model, SlashCommand, ThinkingLevel } from "../../../shared/protocol";
import type { Annotation } from "../../../shared/browser";
import type { Attachment } from "../lib/attachments";
import { fuzzyFilter } from "../lib/fuzzy";
import { desktopLinks, previewClick } from "../lib/preview";
import { detectMenu, type MenuState } from "../../../shared/composer-menu";
import type { SessionState } from "../../../shared/session-state";
import {
  attachFiles,
  compact,
  composerCard,
  interrupt,
  openLightbox,
  pickAttachments,
  removeAnnotation,
  removeAttachment,
  removeComposerCard,
  type SendMode,
  send,
  setModel,
  setThinking,
  showBoard,
  useApp,
} from "../state/app";
import { ColumnIcon } from "./ColumnIcon";
import { ContextMeter } from "./ContextMeter";
import { Dialogs } from "./Dialogs";
import { QueueCard } from "./QueueCard";
import { TokenRate } from "./TokenRate";
import { Popover } from "./primitives";
import { Widget } from "./Widget";

const drafts = new Map<string, string>();
/** The editor text injection each chat has applied, so a remount (switching back to the chat) does not apply it again. */
const injections = new Map<string, number>();
const NO_ATTACHMENTS: Attachment[] = [];
const NO_ANNOTATIONS: Annotation[] = [];
const fileLists = new Map<string, Promise<string[]>>();

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  insert: string;
}

/** How long a first Esc keeps the stop button armed for the second. */
const ESC_ARM_MS = 2500;

/**
 * `placeholder`: what the empty composer suggests while pi is idle (the ATP page's orchestrator has its own).
 * `floating`: no page padding, a translucent, blurred box (the ATP page: over the graph, or in its side column).
 */
export function Composer({ session, placeholder, floating = false }: { session: SessionState; placeholder?: string; floating?: boolean }) {
  const { handle } = session;
  const [text, setTextState] = useState(() => drafts.get(handle) ?? "");
  const [menu, setMenu] = useState<MenuState>();
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  /** The first Esc while pi runs arms the stop button (it shows "esc"); a second Esc stops. */
  const [armed, setArmed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const commands = useApp((state) => state.commands[handle]);
  const compaction = useApp((state) => state.compaction);
  const annotations = useApp((state) => state.annotations[handle]) ?? NO_ANNOTATIONS;
  const attachments = useApp((state) => state.attachments[handle]) ?? NO_ATTACHMENTS;
  const card = useApp((state) => composerCard(state, handle));
  /** Nothing to send: no text, attachment, browser comment or card. */
  const empty = !text.trim() && !attachments.length && !annotations.length && !card;

  const setText = useCallback(
    (value: string) => {
      drafts.set(handle, value);
      setTextState(value);
    },
    [handle],
  );

  // Extensions can prefill the editor (set_editor_text), and so can pi-gna (prefill).
  const injected = session.editorText;
  useEffect(() => {
    if (!injected || injections.get(handle) === injected.nonce) return;
    injections.set(handle, injected.nonce);
    setText(injected.text);
    area.current?.focus();
  }, [injected, handle, setText]);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  });

  useEffect(() => {
    area.current?.focus();
  }, []);

  useEffect(() => {
    if (menu?.kind !== "file") return;
    let list = fileLists.get(session.cwd);
    if (!list) {
      list = window.studio.listFiles(session.cwd);
      fileLists.set(session.cwd, list);
      setTimeout(() => fileLists.delete(session.cwd), 15_000);
    }
    let alive = true;
    void list.then((result) => alive && setFiles(result));
    return () => {
      alive = false;
    };
  }, [menu?.kind, session.cwd]);

  const items: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === "command") {
      return fuzzyFilter(commands ?? [], menu.query, (c: SlashCommand) => c.name, 60).map((c) => ({
        key: c.name,
        label: `/${c.name}`,
        detail: c.description,
        insert: `/${c.name} `,
      }));
    }
    return fuzzyFilter(files, menu.query, (f) => f, 40).map((f) => ({ key: f, label: f, insert: `@${f} ` }));
  }, [menu, commands, files]);

  const accept = (item: MenuItem) => {
    if (!menu) return;
    const caret = area.current?.selectionStart ?? text.length;
    const next = text.slice(0, menu.start) + item.insert + text.slice(caret);
    setText(next);
    setMenu(undefined);
    requestAnimationFrame(() => {
      const position = menu.start + item.insert.length;
      area.current?.setSelectionRange(position, position);
      area.current?.focus();
    });
  };

  const submit = async (mode: SendMode) => {
    if (empty) return;
    const sentText = text;
    setText("");
    // Attachments, comments and the card clear in the store once pi accepts the prompt.
    const ok = await send(handle, text.trim(), mode);
    if (!ok) setText(sentText);
  };

  const stop = async () => {
    const restored = await interrupt(handle);
    if (restored.length) setText([...restored, drafts.get(handle) ?? ""].filter(Boolean).join("\n\n"));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menu && items.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelected((index) => (index + delta + items.length) % items.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = items[selected];
        if (item) accept(item);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (menu) setMenu(undefined);
      else if (!(session.running || session.compacting)) return;
      else if (armed) {
        setArmed(false);
        void stop();
      } else setArmed(true);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(event.altKey ? "followUp" : "send");
    } else if (event.metaKey && event.key.toLowerCase() === "u") {
      event.preventDefault();
      void pickAttachments(handle, "files");
    }
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    const next = detectMenu(event.target.value, event.target.selectionStart);
    setMenu(next);
    setSelected(0);
  };

  // Cmd+V: copied screenshots and images, and files or folders copied in Finder. Text pastes as usual.
  const onPaste = (event: React.ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void attachFiles(handle, files);
  };

  const widgetsAbove = Object.entries(session.widgets).filter(([, w]) => w.placement === "aboveEditor");
  const widgetsBelow = Object.entries(session.widgets).filter(([, w]) => w.placement === "belowEditor");
  const exited = session.phase === "exited";
  const busy = session.running || Boolean(session.compacting);

  useEffect(() => {
    if (!armed) return;
    if (!busy) return setArmed(false);
    const timer = setTimeout(() => setArmed(false), ESC_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed, busy]);

  return (
    <div className={floating ? "flex w-full flex-col gap-2" : "mx-auto flex w-full max-w-[800px] flex-col gap-2 px-8 pb-5"}>
      <Dialogs handle={handle} dialogs={session.dialogs} />
      {widgetsAbove.map(([key, widget]) => (
        <Widget key={key} lines={widget.lines} />
      ))}
      {annotations.length > 0 && (
        <div className="flex flex-col gap-1">
          {annotations.map((annotation) => (
            <div key={annotation.id} className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1.5 text-[12.5px]">
              <MessageSquare size={12} className="shrink-0 text-accent" />
              {annotation.image && (
                <button type="button" onClick={() => openLightbox(`data:image/jpeg;base64,${annotation.image}`)} className="shrink-0">
                  <img alt="" src={`data:image/jpeg;base64,${annotation.image}`} className="h-6 max-w-16 rounded border border-line object-cover" />
                </button>
              )}
              <span className="truncate text-fg">{annotation.comment}</span>
              <span className="min-w-0 shrink truncate font-mono text-[11px] text-faint">{annotation.label}</span>
              <button type="button" title="Remove comment" onClick={() => removeAnnotation(handle, annotation.id)} className="ml-auto shrink-0 text-faint hover:text-fg">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <QueueCard
        session={session}
        onEdit={(queued) => {
          setText([queued, drafts.get(handle) ?? ""].filter(Boolean).join("\n\n"));
          area.current?.focus();
        }}
      />
      {/* pi-colored glow behind the box; the box border becomes a flowing gradient on focus (see .composer). */}
      <div className={`composer relative ${floating ? "composer-floating" : ""}`}>
        <div className="composer-glow" aria-hidden />
      <div className="composer-box relative z-10 rounded-2xl">
        {menu && items.length > 0 && (
          <div className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line-strong bg-panel p-1 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]">
            {items.map((item, index) => (
              <button
                key={item.key}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(item);
                }}
                onMouseEnter={() => setSelected(index)}
                className={`flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left ${index === selected ? "bg-raised" : ""}`}
              >
                <span className="shrink-0 font-mono text-[12.5px] text-fg">{item.label}</span>
                {item.detail && <span className="truncate text-[12px] text-faint">{item.detail}</span>}
              </button>
            ))}
          </div>
        )}

        <AttachmentChips handle={handle} attachments={attachments} card={card} />

        <textarea
          ref={area}
          value={text}
          rows={2}
          disabled={exited}
          placeholder={exited ? "pi exited" : session.phase === "starting" ? "Starting pi…" : session.running ? "Steer the agent…  (⌥⏎ to queue a follow-up)" : (placeholder ?? "Ask pi anything…  @ for files, / for commands")}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setMenu(undefined)}
          onSelect={(event) => {
            if (menu) setMenu(detectMenu(event.currentTarget.value, event.currentTarget.selectionStart));
          }}
          className="selectable block max-h-80 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14.5px] leading-relaxed text-fg outline-none placeholder:text-faint"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <AttachButton handle={handle} disabled={exited} />
          <ModelPicker session={session} />
          <ThinkingPicker session={session} />
          <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
            <TokenRate session={session} />
            <ContextMeter session={session} compaction={compaction} onCompact={() => void compact(handle)} />
            {busy && (empty || armed) ? (
              <button
                type="button"
                onClick={() => {
                  setArmed(false);
                  void stop();
                }}
                title={armed ? "Press Esc again to stop" : "Stop (Esc twice)"}
                className={`grid h-8 min-w-8 place-items-center rounded-full bg-fg text-canvas hover:opacity-90${armed ? " px-2.5 font-mono text-[11px] font-medium" : ""}`}
              >
                {armed ? "esc" : <Square size={11} fill="currentColor" />}
              </button>
            ) : (
              <button
                type="button"
                disabled={empty || exited}
                onClick={() => void submit("send")}
                title={session.running ? "Steer (Enter)" : "Send (Enter)"}
                className="grid h-8 w-8 place-items-center rounded-full bg-accent text-white transition enabled:hover:opacity-90 disabled:bg-raised disabled:text-faint"
              >
                <ArrowUp size={16} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      {widgetsBelow.map(([key, widget]) => (
        <Widget key={key} lines={widget.lines} />
      ))}
    </div>
  );
}

function PickerButton({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-muted enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
    >
      {icon}
      <span className="max-w-48 min-w-0 truncate">{label}</span>
      <ChevronDown size={11} className="shrink-0 text-faint" />
    </button>
  );
}

function ModelPicker({ session }: { session: SessionState }) {
  const models = useApp((state) => state.models);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const label = session.model?.name ?? session.modelRef?.modelId ?? (session.phase === "starting" ? "Starting…" : "No model");
  const filtered = fuzzyFilter(models, query, (m: Model) => `${m.provider}/${m.id} ${m.name}`, 200);
  const choose = (model: Model) => {
    setOpen(false);
    setQuery("");
    void setModel(session.handle, model);
  };
  return (
    // On a narrow composer the model name truncates so the status group on the right keeps its line;
    // min-w-13 keeps room for the icon, the chevron and the padding.
    <div className="relative min-w-13">
      <PickerButton icon={<Cpu size={13} className="shrink-0" />} label={label} disabled={session.phase !== "ready"} onClick={() => setOpen(!open)} />
      <Popover open={open} onClose={close} className="bottom-full left-0 mb-2 w-80 p-1">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && filtered[0]) choose(filtered[0]);
          }}
          placeholder="Search models"
          className="mb-1 w-full rounded-lg bg-sunken px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-faint"
        />
        <div className="max-h-80 overflow-y-auto">
          {filtered.map((model) => {
            const active = model.id === session.model?.id && model.provider === session.model?.provider;
            return (
              <button
                key={`${model.provider}/${model.id}`}
                type="button"
                onClick={() => choose(model)}
                className={`flex w-full items-baseline justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-raised ${active ? "text-accent" : "text-fg"}`}
              >
                <span className="truncate text-[12.5px]">{model.name}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-faint">{model.provider}</span>
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

function ThinkingPicker({ session }: { session: SessionState }) {
  const levels = useApp((state) => state.levels[session.handle]);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!levels || (levels.length === 1 && levels[0] === "off")) return null;
  return (
    <div className="relative">
      <PickerButton icon={<Brain size={13} className="shrink-0" />} label={session.thinkingLevel ?? "thinking"} disabled={session.phase !== "ready"} onClick={() => setOpen(!open)} />
      <Popover open={open} onClose={close} className="bottom-full left-0 mb-2 w-40 p-1">
        {levels.map((level: ThinkingLevel) => (
          <button
            key={level}
            type="button"
            onClick={() => {
              setOpen(false);
              void setThinking(session.handle, level);
            }}
            className={`block w-full rounded-lg px-2.5 py-1.5 text-left font-mono text-[12px] hover:bg-raised ${level === session.thinkingLevel ? "text-accent" : "text-fg"}`}
          >
            {level}
          </button>
        ))}
      </Popover>
    </div>
  );
}

function AttachButton({ handle, disabled }: { handle: string; disabled: boolean }) {
  // Photos are files: one picker takes files, folders and images (images still go as image content).
  return (
    <button
      type="button"
      disabled={disabled}
      title={"Attach files and folders (⌘U)\nYou can also drop files anywhere or paste with ⌘V."}
      aria-label="Attach files and folders"
      onClick={() => void pickAttachments(handle, "files")}
      className="grid h-7 w-7 place-items-center rounded-lg text-muted enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
    >
      <Plus size={16} />
    </button>
  );
}

function AttachmentChips({ handle, attachments, card }: { handle: string; attachments: Attachment[]; card: Card | undefined }) {
  if (!attachments.length && !card) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {card && <CardChip handle={handle} card={card} />}
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group relative" title={attachment.path ?? attachment.name}>
          {attachment.kind === "image" ? (
            <button type="button" onClick={() => openLightbox(`data:${attachment.mimeType};base64,${attachment.data}`)} className="block cursor-zoom-in">
              <img alt={attachment.name} className="h-14 w-14 rounded-lg border border-line object-cover" src={`data:${attachment.mimeType};base64,${attachment.data}`} />
            </button>
          ) : (
            <div
              onClick={attachment.path && !attachment.isDir ? previewClick(desktopLinks, attachment.path) : undefined}
              className={`flex h-14 max-w-56 items-center gap-2 rounded-lg border border-line bg-sunken px-3 ${attachment.path && !attachment.isDir ? "cursor-pointer hover:bg-raised" : ""}`}
            >
              {attachment.isDir ? <Folder size={15} className="shrink-0 text-muted" /> : <FileText size={15} className="shrink-0 text-muted" />}
              <span className="truncate text-[12.5px] text-fg">
                {attachment.name}
                {attachment.isDir ? "/" : ""}
              </span>
            </div>
          )}
          <button
            type="button"
            title={`Remove ${attachment.name}`}
            onClick={() => removeAttachment(handle, attachment.id)}
            className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-line bg-panel p-0.5 text-muted hover:text-fg group-hover:block"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The card a chat is about ("Chat about it"): its details go with your message, so they stay out of the text. */
function CardChip({ handle, card }: { handle: string; card: Card }) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => showBoard(card.cwd, card.id)}
        title={`${card.title}\nIts details go with your message, and this chat joins the card. Click to open it on the board.`}
        className="flex h-14 max-w-72 min-w-0 items-center gap-2.5 rounded-lg border border-line bg-sunken px-3 text-left hover:border-line-strong"
      >
        <SquareKanban size={15} className="shrink-0 text-muted" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] text-fg">{card.title}</span>
          <span className="flex items-center gap-1 text-[11px] text-faint">
            <ColumnIcon column={card.column} size={11} />
            {COLUMN_LABELS[card.column]}
          </span>
        </span>
      </button>
      <button
        type="button"
        title="Remove the card: this chat is not told about it and does not join it"
        onClick={() => removeComposerCard(handle)}
        className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-line bg-panel p-0.5 text-muted hover:text-fg group-hover:block"
      >
        <X size={11} />
      </button>
    </div>
  );
}
