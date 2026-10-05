// The phone's composer: text with / commands and @ file mentions as touch lists, Send (a steer while the agent
// works), Queue as a follow-up, Stop with a confirmation, and the chat chrome the desktop composer has: model and
// thinking sheets, tok/s, the context meter, the queue card, retry callouts and extension widgets.
// The host composes and delivers the message (`chat.send`); the draft stays on the phone, per chat.
import { ArrowUp, Brain, ChevronDown, Cpu, ListEnd, Plus, RotateCw, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMeter } from "../renderer/src/components/ContextMeter";
import { QueueCard } from "../renderer/src/components/QueueCard";
import { TokenRate } from "../renderer/src/components/TokenRate";
import { Widget } from "../renderer/src/components/Widget";
import { fuzzyFilter } from "../renderer/src/lib/fuzzy";
import { applyMenuChoice, detectMenu, type MenuState } from "../shared/composer-menu";
import type { SlashCommand } from "../shared/protocol";
import type { SessionState } from "../shared/session-state";
import type { HostClient } from "./client/host-client";
import { hasLevels, projectFiles, useComposerData } from "./composer-data";
import { addHostPath, type Attached, nextKey, readyRefs, refusal, uploading } from "./attach-state";
import { AttachmentChips, AttachSheet, HostFilesSheet } from "./Attachments";
import { ModelSheet, ThinkingSheet } from "./Sheets";
import { draftKey, loadDraft, saveDraft, withRestored } from "./drafts";
import { toast } from "./toasts";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The editor text injection each chat has applied, so a remount does not apply it again (as in the desktop composer). */
const injections = new Map<string, number>();

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  insert: string;
}

export function MobileComposer({ client, session: reduced }: { client: HostClient; session: SessionState }) {
  const data = useComposerData(client, reduced);
  const session = data.session;
  const [menu, setMenu] = useState<MenuState>();
  const [files, setFiles] = useState<string[]>([]);
  const [sheet, setSheet] = useState<"model" | "thinking" | "attach" | "host">();
  const [attached, setAttached] = useState<Attached[]>([]);
  const key = draftKey(reduced);
  const [text, setText] = useState(() => loadDraft(key));
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

  const items: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === "command") {
      return fuzzyFilter(data.commands, menu.query, (c: SlashCommand) => c.name, 40).map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.description, insert: `/${c.name} ` }));
    }
    return fuzzyFilter(files, menu.query, (f) => f, 30).map((f) => ({ key: f, label: f, insert: `@${f} ` }));
  }, [menu, data.commands, files]);

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
  const typed = text.trim().length > 0 || refs.length > 0;
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
      current = [...current, { key, name, source: "upload", image, state: "uploading" }];
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
    setBusy(true);
    try {
      const result = await client.call("chat.send", { handle: session.handle, text: sent.trim(), mode, ...(sentRefs.length ? { attachments: sentRefs } : {}) });
      if (result.accepted) {
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

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
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
      <QueueCard touch session={session} onEdit={(queued) => edit((current) => withRestored(current, [queued]))} />
      <div className="relative z-[2] rounded-2xl border border-line-strong bg-panel">
        {confirmStop ? (
          <div className="flex flex-col gap-3 p-3.5" role="alertdialog" aria-label="Stop the agent">
            <div className="text-[14px] text-fg">Stop the agent?</div>
            <div className="text-[12.5px] text-muted">The run ends. Messages still queued come back into the composer.</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void stop()} className="rounded-xl bg-bad px-5 py-2.5 text-[15px] font-medium text-white" data-testid="confirm-stop">
                Stop
              </button>
              <button type="button" onClick={() => setConfirmStop(false)} className="rounded-xl border border-line px-5 py-2.5 text-[15px] text-muted">
                Keep going
              </button>
            </div>
          </div>
        ) : (
          <>
            {menu && items.length > 0 && (
              <div className="max-h-56 overflow-y-auto border-b border-line p-1" data-testid="menu-list" role="listbox">
                {items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => accept(item)}
                    className="flex min-h-11 w-full items-baseline gap-3 rounded-lg px-2.5 py-2 text-left"
                    data-testid="menu-item"
                  >
                    <span className="shrink-0 font-mono text-[13.5px] text-fg">{item.label}</span>
                    {item.detail && <span className="truncate text-[12.5px] text-faint">{item.detail}</span>}
                  </button>
                ))}
              </div>
            )}
            <AttachmentChips list={attached} onRemove={(key) => setAttached((list) => list.filter((a) => a.key !== key))} />
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
              className="selectable block max-h-40 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[16px] leading-snug text-fg outline-none placeholder:text-faint"
            />
            <div className="flex items-center gap-1 px-2" data-testid="status-row">
              <button type="button" aria-label="Attach" disabled={ended} onClick={() => setSheet("attach")} data-testid="attach" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-muted disabled:opacity-50">
                <Plus size={18} />
              </button>
              <button type="button" disabled={session.phase !== "ready"} onClick={() => setSheet("model")} data-testid="model-chip" className="flex min-h-10 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted disabled:opacity-50">
                <Cpu size={14} className="shrink-0" />
                <span className="max-w-32 truncate">{session.model?.name ?? session.modelRef?.modelId ?? (session.phase === "starting" ? "Starting…" : "No model")}</span>
                <ChevronDown size={11} className="shrink-0 text-faint" />
              </button>
              {hasLevels(data.levels) && (
                <button type="button" disabled={session.phase !== "ready"} onClick={() => setSheet("thinking")} data-testid="thinking-chip" className="flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted disabled:opacity-50">
                  <Brain size={14} className="shrink-0" />
                  {session.thinkingLevel ?? "thinking"}
                  <ChevronDown size={11} className="shrink-0 text-faint" />
                </button>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <TokenRate session={session} />
                <ContextMeter touch session={session} compaction={data.compaction} onCompact={() => void data.compactNow()} />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-2 pb-2">
              {running && (
                <button type="button" aria-label="Stop" data-testid="stop" onClick={() => setConfirmStop(true)} className="mr-auto grid h-10 w-10 place-items-center rounded-full border border-bad/50 text-bad">
                  <Square size={14} fill="currentColor" />
                </button>
              )}
              {running && (
                <button type="button" disabled={!typed || waiting || busy} onClick={() => void send("followUp")} data-testid="queue" className="flex h-10 items-center gap-1.5 rounded-full border border-line px-3.5 text-[14px] text-muted disabled:opacity-40">
                  <ListEnd size={15} /> Queue
                </button>
              )}
              <button
                type="button"
                aria-label={running ? "Send now" : "Send"}
                data-testid="send"
                disabled={!typed || waiting || busy || ended}
                onClick={() => void send("send")}
                className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full bg-accent px-3 text-[14px] font-medium text-white disabled:opacity-40"
              >
                <ArrowUp size={18} />
                {running && <span>Steer</span>}
              </button>
            </div>
          </>
        )}
      </div>
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
          onClose={() => setSheet(undefined)}
          onPick={(model) => {
            setSheet(undefined);
            void data.pickModel(model);
          }}
        />
      )}
      {sheet === "thinking" && hasLevels(data.levels) && (
        <ThinkingSheet
          levels={data.levels}
          current={session.thinkingLevel}
          onClose={() => setSheet(undefined)}
          onPick={(level) => {
            setSheet(undefined);
            void data.pickThinking(level);
          }}
        />
      )}
      {Object.entries(session.widgets).filter(([, w]) => w.placement === "belowEditor").map(([key, widget]) => (
        <div key={key} className="mt-2" data-testid="widget"><Widget lines={widget.lines} /></div>
      ))}
    </div>
  );
}
