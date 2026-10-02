import { ArrowUp, Brain, ChevronDown, Cpu, MessageSquare, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, Model, SlashCommand, ThinkingLevel } from "../../../shared/protocol";
import { fuzzyFilter } from "../lib/fuzzy";
import type { SessionState } from "../lib/session";
import { interrupt, openLightbox, removeAnnotation, type SendMode, send, setModel, setThinking, useApp } from "../state/app";
import { Dialogs } from "./Dialogs";
import { Ansi, Kbd, Popover } from "./primitives";

const drafts = new Map<string, string>();
const fileLists = new Map<string, Promise<string[]>>();

interface MenuState {
  kind: "command" | "file";
  query: string;
  /** Index in the text where the trigger (/ or @) starts. */
  start: number;
}

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  insert: string;
}

function detectMenu(text: string, caret: number): MenuState | undefined {
  const before = text.slice(0, caret);
  const command = before.match(/^\/(\S*)$/);
  if (command) return { kind: "command", query: command[1] ?? "", start: 0 };
  const file = before.match(/(^|\s)@([^\s@]*)$/);
  if (file) return { kind: "file", query: file[2] ?? "", start: caret - (file[2]?.length ?? 0) - 1 };
  return undefined;
}

export function Composer({ session }: { session: SessionState }) {
  const { handle } = session;
  const [text, setTextState] = useState(() => drafts.get(handle) ?? "");
  const [images, setImages] = useState<ImageContent[]>([]);
  const [menu, setMenu] = useState<MenuState>();
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const commands = useApp((state) => state.commands[handle]);
  const annotations = useApp((state) => state.annotations);

  const setText = useCallback(
    (value: string) => {
      drafts.set(handle, value);
      setTextState(value);
    },
    [handle],
  );

  // Extensions can prefill the editor (set_editor_text).
  const injected = session.editorText;
  useEffect(() => {
    if (injected) setText(injected.text);
  }, [injected, setText]);

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
    const message = text.trim();
    if (!message && !images.length && !annotations.length) return;
    const sentText = text;
    const sentImages = images;
    setText("");
    setImages([]);
    const ok = await send(handle, message, sentImages, mode);
    if (!ok) {
      setText(sentText);
      setImages(sentImages);
    }
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
      else if (session.running) void stop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(event.altKey ? "followUp" : "send");
    }
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    const next = detectMenu(event.target.value, event.target.selectionStart);
    setMenu(next);
    setSelected(0);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const pasted = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/"));
    if (!pasted.length) return;
    event.preventDefault();
    for (const item of pasted) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1] ?? "";
        setImages((current) => [...current, { type: "image", data, mimeType: file.type }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const queued = [...session.queue.steering.map((t) => ["steer", t] as const), ...session.queue.followUp.map((t) => ["queued", t] as const)];
  const widgetsAbove = Object.entries(session.widgets).filter(([, w]) => w.placement === "aboveEditor");
  const widgetsBelow = Object.entries(session.widgets).filter(([, w]) => w.placement === "belowEditor");
  const exited = session.phase === "exited";

  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-col gap-2 px-8 pb-2">
      <Dialogs handle={handle} dialogs={session.dialogs} />
      {widgetsAbove.map(([key, widget]) => (
        <Widget key={key} lines={widget.lines} />
      ))}
      {queued.length > 0 && (
        <div className="flex flex-col gap-1">
          {queued.map(([kind, message], index) => (
            <div key={index} className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-[12.5px] text-muted">
              <span className="font-mono text-[10.5px] uppercase tracking-wide text-faint">{kind}</span>
              <span className="truncate">{message}</span>
            </div>
          ))}
        </div>
      )}

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
              <button type="button" title="Remove comment" onClick={() => removeAnnotation(annotation.id)} className="ml-auto shrink-0 text-faint hover:text-fg">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative rounded-2xl border border-line-strong bg-panel transition focus-within:border-accent/50">
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

        {images.length > 0 && (
          <div className="flex gap-2 px-3 pt-3">
            {images.map((image, index) => (
              <div key={index} className="group relative">
                <img alt="" className="h-14 w-14 rounded-lg border border-line object-cover" src={`data:${image.mimeType};base64,${image.data}`} />
                <button
                  type="button"
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-line bg-panel p-0.5 group-hover:block"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={area}
          value={text}
          rows={1}
          disabled={exited}
          placeholder={exited ? "pi exited" : session.running ? "Steer the agent…  (⌥⏎ to queue a follow-up)" : "Ask pi anything…  @ for files, / for commands"}
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
          <ModelPicker session={session} />
          <ThinkingPicker session={session} />
          <div className="ml-auto flex items-center gap-2">
            {session.running && (
              <span className="hidden text-[11px] text-faint sm:inline">
                <Kbd>esc</Kbd> stop
              </span>
            )}
            {session.running && !text.trim() && !annotations.length ? (
              <button type="button" onClick={() => void stop()} title="Stop (Esc)" className="grid h-8 w-8 place-items-center rounded-full bg-fg text-canvas hover:opacity-90">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                disabled={(!text.trim() && !images.length && !annotations.length) || exited}
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
      {widgetsBelow.map(([key, widget]) => (
        <Widget key={key} lines={widget.lines} />
      ))}
    </div>
  );
}

function Widget({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-sunken px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
      {lines.map((line, index) => (
        <div key={index} className="whitespace-pre-wrap">
          <Ansi text={line} />
        </div>
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
      className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-muted enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
    >
      {icon}
      <span className="max-w-48 truncate">{label}</span>
      <ChevronDown size={11} className="text-faint" />
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
    <div className="relative">
      <PickerButton icon={<Cpu size={13} />} label={label} disabled={session.phase !== "ready"} onClick={() => setOpen(!open)} />
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
      <PickerButton icon={<Brain size={13} />} label={session.thinkingLevel ?? "thinking"} disabled={session.phase !== "ready"} onClick={() => setOpen(!open)} />
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
