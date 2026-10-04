// The phone's composer: text, Send (a steer while the agent works), Queue as a follow-up, and Stop with a confirmation.
// The host composes and delivers the message (`chat.send`); the draft stays on the phone, per chat.
import { ArrowUp, ListEnd, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { QueueCard } from "../renderer/src/components/QueueCard";
import type { SessionState } from "../shared/session-state";
import type { HostClient } from "./client/host-client";
import { draftKey, loadDraft, saveDraft, withRestored } from "./drafts";
import { toast } from "./toasts";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function MobileComposer({ client, session }: { client: HostClient; session: SessionState }) {
  const key = draftKey(session);
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

  const running = session.running || Boolean(session.compacting);
  const ended = session.phase === "exited";
  const typed = text.trim().length > 0;

  const send = async (mode: "send" | "followUp") => {
    if (!typed || busy || ended) return;
    const sent = text;
    setBusy(true);
    try {
      const result = await client.call("chat.send", { handle: session.handle, text: sent.trim(), mode });
      if (result.accepted) edit((current) => (current === sent ? "" : current));
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
      <QueueCard session={session} onEdit={(queued) => edit((current) => withRestored(current, [queued]))} />
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
            <textarea
              ref={field}
              value={text}
              rows={1}
              disabled={ended}
              placeholder={ended ? "This chat has ended" : running ? "Steer the agent…" : "Message pi…"}
              enterKeyHint="enter"
              autoCapitalize="sentences"
              onChange={(event) => edit(event.target.value)}
              className="selectable block max-h-40 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[16px] leading-snug text-fg outline-none placeholder:text-faint"
            />
            <div className="flex items-center justify-end gap-2 px-2 pb-2">
              {running && (
                <button type="button" aria-label="Stop" data-testid="stop" onClick={() => setConfirmStop(true)} className="mr-auto grid h-10 w-10 place-items-center rounded-full border border-bad/50 text-bad">
                  <Square size={14} fill="currentColor" />
                </button>
              )}
              {running && (
                <button type="button" disabled={!typed || busy} onClick={() => void send("followUp")} data-testid="queue" className="flex h-10 items-center gap-1.5 rounded-full border border-line px-3.5 text-[14px] text-muted disabled:opacity-40">
                  <ListEnd size={15} /> Queue
                </button>
              )}
              <button
                type="button"
                aria-label={running ? "Send now" : "Send"}
                data-testid="send"
                disabled={!typed || busy || ended}
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
    </div>
  );
}
