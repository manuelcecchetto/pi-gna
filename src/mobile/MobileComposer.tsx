// The phone's composer, shaped like iOS Messages: + for attachments, a capsule field with Send inside (a steer while
// the agent works, plus Queue once there is text), and Stop beside it while pi runs, with a confirmation. Model,
// thinking, tok/s and the context meter sit in a quiet row above. / commands and @ file mentions are touch lists, and the chat chrome the desktop composer has: model and
// thinking sheets, tok/s, the context meter, the queue card, retry callouts and extension widgets.
// The host composes and delivers the message (`chat.send`); the draft stays on the phone, per chat.
import { useStore } from "../renderer/src/lib/store";
import { ArrowUp, ChevronDown, ListEnd, Plus, RotateCw, Square, Zap } from "../renderer/src/components/icons";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ContextMeter } from "../renderer/src/components/ContextMeter";
import { QueueCard } from "../renderer/src/components/QueueCard";
import { TokenRate } from "../renderer/src/components/TokenRate";
import { Widget } from "../renderer/src/components/Widget";
import { lastCacheHit } from "../renderer/src/lib/context";
import { fuzzySearch } from "../renderer/src/lib/fuzzy";
import { applyMenuChoice, detectMenu, type MenuState } from "../shared/composer-menu";
import type { SlashCommand } from "../shared/protocol";
import type { SessionState } from "../shared/session-state";
import type { HostClient } from "./client/host-client";
import { hasLevels, projectFiles, useComposerData } from "./composer-data";
import { addHostPath, type Attached, nextKey, readyRefs, refusal, uploading } from "./attach-state";
import { AttachmentChips, AttachSheet, HostFilesSheet } from "./Attachments";
import { ModelSheet } from "./Sheets";
import { LazyProviderLogo } from "../renderer/src/components/LazyProviderLogo";
import { fastApplies, isFast, modelChipLabel } from "../shared/fast";
import { draftKey, loadDraft, saveDraft, withRestored } from "./drafts";
import { toast } from "./toasts";
import { annotations as phoneAnnotations, useAnnotations } from "./annotations";
import { AnnotationChips } from "./Browser";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The editor text injection each chat has applied, so a remount does not apply it again (as in the desktop composer). */
const injections = new Map<string, number>();

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  insert: string;
}

export function MobileComposer({ client, session: reduced, initialText = "", cardId }: { client: HostClient; session: SessionState; initialText?: string; cardId?: string }) {
  /** The card riding with the next message; gone once a message took it, or when taken off. */
  const [card, setCard] = useState(cardId);
  const board = useStore(client.store, (s) => s.global.board);
  const cardTitle = card ? board?.cards.find((other) => other.id === card)?.title : undefined;
  const data = useComposerData(client, reduced);
  const session = data.session;
  const provider = session.model?.provider ?? session.modelRef?.provider;
  const gpt = fastApplies(provider);
  const [menu, setMenu] = useState<MenuState>();
  const [files, setFiles] = useState<string[]>([]);
  const [sheet, setSheet] = useState<"model" | "attach" | "host">();
  const [attached, setAttached] = useState<Attached[]>([]);
  const key = draftKey(reduced);
  const [text, setText] = useState(() => loadDraft(key) || initialText);
  const comments = useAnnotations();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const keyed = useRef(key);

  // A chat of its own gets its own draft: pi names the session file after the chat opened.
  useEffect(() => {
    if (keyed.current === key) return;
    saveDraft(key, loadDraft(keyed.current));
    saveDraft(keyed.current, "");
    keyed.current = key;
  }, [key]);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);

  const edit = (next: string | ((current: string) => string)) =>
    setText((current) => {
      const value = typeof next === "function" ? next(current) : next;
      saveDraft(key, value);
      return value;
    });

  // Extensions can prefill the editor (set_editor_text).
  const injected = session.editorText;
  useEffect(() => {
    if (!injected || injections.get(session.handle) === injected.nonce) return;
    injections.set(session.handle, injected.nonce);
    edit(injected.text);
    field.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected, session.handle]);

  useEffect(() => {
    if (menu?.kind !== "file") return;
    let alive = true;
    void projectFiles(client, session.cwd).then((list) => alive && setFiles(list));
    return () => {
      alive = false;
    };
  }, [client, menu?.kind, session.cwd]);

  // Up to 50k paths: each list is searched by one searcher, and a keystroke paints before its results do.
  const searchCommands = useMemo(() => fuzzySearch(data.commands, (c: SlashCommand) => c.name), [data.commands]);
  const searchFiles = useMemo(() => fuzzySearch(files, (f) => f), [files]);
  const kind = menu?.kind;
  const query = useDeferredValue(menu?.query ?? "");
  const items: MenuItem[] = useMemo(() => {
    if (!kind) return [];
    if (kind === "command") {
      return searchCommands(query, 40).map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.description, insert: `/${c.name} ` }));
    }
    return searchFiles(query, 30).map((f) => ({ key: f, label: f, insert: `@${f} ` }));
  }, [kind, query, searchCommands, searchFiles]);

  const accept = (item: MenuItem) => {
    if (!menu) return;
    const caret = field.current?.selectionStart ?? text.length;
    const next = applyMenuChoice(text, menu, item.insert, caret);
    edit(next.text);
    setMenu(undefined);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const running = session.running || Boolean(session.compacting);
  const ended = session.phase === "exited";
  const refs = readyRefs(attached);
  const typed = text.trim().length > 0 || refs.length > 0 || comments.length > 0;
  const waiting = uploading(attached);

  /** Each file uploads at once, so Send only waits for the slowest; a failed one stays as a red chip to remove. */
  const addFiles = (files: File[]) => {
    let current = attached;
    for (const file of files) {
      const name = file.name || "image";
      const why = refusal(current, file);
      if (why) {
        toast(why, "error");
        continue;
      }
      const key = nextKey();
      const image = file.type.startsWith("image/");
      current = [...current, { key, name, source: "upload", image, ...(image ? { file } : {}), state: "uploading" }];
      const settle = (patch: Partial<Attached>) => setAttached((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));
      void client
        .upload(file, name)
        .then((done) => settle({ state: "ready", ref: { upload: done.id }, name: done.name, image: Boolean(done.image) }))
        .catch((error) => settle({ state: "error", error: failure(error) }));
    }
    setAttached(current);
  };

  const send = async (mode: "send" | "followUp") => {
    if (!typed || waiting || busy || ended) return;
    const sent = text;
    const sentRefs = refs;
    // Browser comments ride with a prompt, not a slash command.
    const sentComments = sent.trim().startsWith("/") ? [] : comments;
    setBusy(true);
    try {
      const result = await client.call("chat.send", { handle: session.handle, text: sent.trim(), mode, ...(card && !sent.trim().startsWith("/") ? { cardId: card } : {}), ...(sentRefs.length ? { attachments: sentRefs } : {}), ...(sentComments.length ? { annotations: sentComments } : {}) });
      if (result.accepted) {
        if (card && !sent.trim().startsWith("/")) setCard(undefined);
        phoneAnnotations.drop(sentComments);
        edit((current) => (current === sent ? "" : current));
        setAttached((list) => list.filter((a) => a.state === "error" || !a.ref || !sentRefs.includes(a.ref)));
      }
      else toast(result.error ?? "pi did not take the message", "error");
    } catch (error) {
      toast(`Could not send: ${failure(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setConfirmStop(false);
    try {
      const restored = await client.call("chat.interrupt", { handle: session.handle });
      if (restored.length) edit((current) => withRestored(current, restored));
    } catch (error) {
      toast(`Could not stop: ${failure(error)}`, "error");
    }
  };

  const circle = "grid h-11 w-11 shrink-0 place-items-center rounded-full";
  return (
    <div className="shrink-0 px-3 pb-2 pt-1">
      {Object.entries(session.widgets).filter(([, w]) => w.placement === "aboveEditor").map(([key, widget]) => (
        <div key={key} className="mb-2" data-testid="widget"><Widget lines={widget.lines} /></div>
      ))}
      {session.retry && (
        <div className="mb-2 flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/5 px-3 py-2.5 text-[13px] text-warn" role="status" data-testid="retry-callout">
          <RotateCw size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Retrying ({session.retry.attempt}/{session.retry.maxAttempts}): <span className="break-words text-muted">{session.retry.errorMessage}</span>
          </span>
          <button type="button" onClick={() => void client.call("chat.command", { handle: session.handle, command: { type: "abort_retry" } }).catch((e) => toast(`Could not cancel the retry: ${failure(e)}`, "error"))} className="shrink-0 rounded-lg border border-warn/40 px-3 py-1.5 text-[12.5px]">
            Give up
          </button>
        </div>
      )}
      {card && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-muted" data-testid="card-chip">
          <span className="min-w-0 flex-1 truncate">Card: <span className="text-fg">{cardTitle ?? card}</span></span>
          <button type="button" aria-label="Leave the card out" onClick={() => setCard(undefined)} className="grid h-8 w-8 place-items-center text-faint">
            ×
          </button>
        </div>
      )}
      <QueueCard touch session={session} onEdit={(queued) => edit((current) => withRestored(current, [queued]))} />
      {menu && items.length > 0 && (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-2xl border border-line-strong bg-panel p-1" data-testid="menu-list" role="listbox">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={false}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => accept(item)}
              className="flex min-h-11 w-full items-baseline gap-3 rounded-xl px-2.5 py-2 text-left"
              data-testid="menu-item"
            >
              <span className="shrink-0 font-mono text-[13.5px] text-fg">{item.label}</span>
              {item.detail && <span className="truncate text-[12.5px] text-faint">{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
      {/* Session settings ride above the field, quiet; the field row holds only what a thumb needs. */}
      <div className="flex h-9 items-center gap-0.5" data-testid="status-row">
        <button type="button" disabled={session.phase !== "ready"} onClick={() => setSheet("model")} data-testid="model-chip" className="flex h-9 min-w-0 items-center gap-1 rounded-full px-2 text-[12.5px] text-muted active:bg-raised disabled:opacity-50">
          {provider && <LazyProviderLogo id={provider} size={16} />}
          <span className="max-w-52 truncate">
            {modelChipLabel(session.model?.name ?? session.modelRef?.modelId ?? (session.phase === "starting" ? "Starting…" : "No model"), session.thinkingLevel, data.levels)}
          </span>
          {gpt && isFast(session.statuses) && <Zap size={12} className="shrink-0 text-warn" fill="currentColor" aria-label="Fast mode on" data-testid="fast-zap" />}
          <ChevronDown size={12} className="shrink-0 text-faint" />
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {running && <TokenRate items={session.items} running={session.running} />}
          <ContextMeter touch session={session} cacheHit={lastCacheHit(session.items)} compaction={data.compaction} onCompact={() => void data.compactNow()} />
        </div>
      </div>
      {confirmStop ? (
        <div className="flex flex-col gap-3 rounded-3xl border border-line-strong bg-panel p-4" role="alertdialog" aria-label="Stop the agent">
          <div className="text-[15px] text-fg">Stop the agent?</div>
          <div className="text-[13px] text-muted">The run ends. Messages still queued come back into the composer.</div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void stop()} className="h-11 flex-1 rounded-full bg-bad text-[15px] font-medium text-white" data-testid="confirm-stop">
              Stop
            </button>
            <button type="button" onClick={() => setConfirmStop(false)} className="h-11 flex-1 rounded-full border border-line text-[15px] text-muted">
              Keep going
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <button type="button" aria-label="Attach" disabled={ended} onClick={() => setSheet("attach")} data-testid="attach" className={`${circle} bg-raised text-muted active:text-fg disabled:opacity-50`}>
            <Plus size={20} />
          </button>
          {/* A capsule that grows into a rounded rect; the 34 px buttons sit 4.5 px in, concentric with its 22 px ends. */}
          <div className="flex min-h-11 min-w-0 flex-1 flex-col rounded-[22px] border border-line-strong bg-panel">
            <AnnotationChips />
            <AttachmentChips list={attached} onRemove={(key) => setAttached((list) => list.filter((a) => a.key !== key))} />
            <div className="flex items-end">
              <textarea
                ref={field}
                value={text}
                rows={1}
                disabled={ended}
                placeholder={ended ? "This chat has ended" : running ? "Steer the agent…" : "Message pi…"}
                enterKeyHint="enter"
                autoCapitalize="sentences"
                onChange={(event) => {
                  edit(event.target.value);
                  setMenu(detectMenu(event.target.value, event.target.selectionStart));
                }}
                onPaste={(event) => {
                  // Where iOS hands over a pasted image as a file.
                  const images = [...event.clipboardData.files].filter((f) => f.type.startsWith("image/"));
                  if (!images.length) return;
                  event.preventDefault();
                  addFiles(images);
                }}
                onSelect={(event) => {
                  if (menu) setMenu(detectMenu(event.currentTarget.value, event.currentTarget.selectionStart));
                }}
                className="selectable block max-h-40 min-w-0 flex-1 resize-none bg-transparent py-[10px] pl-4 pr-1 text-[16px] leading-[22px] text-fg outline-none placeholder:text-faint"
              />
              {running && typed && (
                <button type="button" aria-label="Queue after the run" disabled={waiting || busy} onClick={() => void send("followUp")} data-testid="queue" className="m-[4.5px] mr-0 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-muted active:bg-raised disabled:opacity-40">
                  <ListEnd size={18} />
                </button>
              )}
              <button
                type="button"
                aria-label={running ? "Steer now" : "Send"}
                data-testid="send"
                disabled={!typed || waiting || busy || ended}
                onClick={() => void send("send")}
                className="m-[4.5px] grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-accent text-white transition-opacity disabled:opacity-30"
              >
                <ArrowUp size={19} strokeWidth={2.5} />
              </button>
            </div>
          </div>
          {running && (
            <button type="button" aria-label="Stop" data-testid="stop" onClick={() => setConfirmStop(true)} className={`${circle} bg-bad/15 text-bad`}>
              <Square size={14} fill="currentColor" />
            </button>
          )}
        </div>
      )}
      {sheet === "attach" && <AttachSheet onClose={() => setSheet(undefined)} onFiles={addFiles} onHost={() => setSheet("host")} />}
      {sheet === "host" && (
        <HostFilesSheet
          client={client}
          onClose={() => setSheet(undefined)}
          onPick={(item) => {
            setSheet(undefined);
            setAttached((list) => addHostPath(list, item));
          }}
        />
      )}
      {sheet === "model" && (
        <ModelSheet
          models={data.models}
          current={session.model}
          levels={hasLevels(data.levels) ? data.levels : undefined}
          level={session.thinkingLevel}
          fast={gpt ? isFast(session.statuses) : undefined}
          onClose={() => setSheet(undefined)}
          onPick={(model) => void data.pickModel(model)}
          onLevel={(level) => void data.pickThinking(level)}
          onFast={(on) => void data.setFast(on)}
        />
      )}
      {Object.entries(session.widgets).filter(([, w]) => w.placement === "belowEditor").map(([key, widget]) => (
        <div key={key} className="mt-2" data-testid="widget"><Widget lines={widget.lines} /></div>
      ))}
    </div>
  );
}
