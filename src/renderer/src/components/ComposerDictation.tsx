// The composer's dictation (src/shared/dictation.ts): the mic button and Right Option record, the local speech model
// transcribes, and the text goes in at the caret as an editing command, so ⌘Z / Ctrl+Z takes it back.
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { dictationInsert, MAX_SECONDS, SAMPLE_RATE } from "../../../shared/dictation";
import { Recording, RightOptionGesture, useDictationStatus } from "../lib/dictation";
import { useApp } from "../state/app";
import { LoaderCircle, Mic } from "./icons";

type Phase = "idle" | "starting" | "recording" | "transcribing";

/** Shorter recordings (a slip of the key) are dropped without asking the model. */
const MIN_SAMPLES = SAMPLE_RATE * 0.3;
/** How long a dictation error stays beside the button. */
const ERROR_MS = 6000;

const editable = (element: Element | null): boolean =>
  element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(element.type)) || (element instanceof HTMLElement && element.isContentEditable);

export interface ComposerDictation {
  on: boolean;
  phase: Phase;
  ready: boolean;
  /** What the button says when hovered: the model's download, a failure, or how to use it. */
  title: string;
  error: string | undefined;
  startedAt: number;
  toggle(): void;
}

/**
 * Dictation for one composer. Right Option works while this chat is the active one and no other text field has the
 * focus; the transcript goes in where the caret was in the composer's text box.
 */
export function useComposerDictation(handle: string, area: RefObject<HTMLTextAreaElement | null>, disabled: boolean): ComposerDictation {
  const on = useApp((state) => state.settings.dictation);
  const active = useApp((state) => state.active === handle);
  const status = useDictationStatus(on);
  const ready = status?.phase === "ready" || status?.phase === "starting";
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const [startedAt, setStartedAt] = useState(0);
  const phaseRef = useRef<Phase>("idle");
  const recording = useRef<Recording>(undefined);
  /** A stop that came while the microphone was still opening. */
  const stopSoon = useRef(false);
  const limit = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(undefined), ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const insert = useCallback(
    (transcript: string) => {
      const element = area.current;
      if (!element || element.disabled) return;
      element.focus();
      const text = dictationInsert(element.value.slice(0, element.selectionStart), transcript, element.value.slice(element.selectionEnd));
      // An editing command, not setText: the insert joins the text box's undo stack.
      if (text) document.execCommand("insertText", false, text);
    },
    [area],
  );

  const stop = useCallback(async () => {
    clearTimeout(limit.current);
    const current = recording.current;
    if (!current) {
      if (phaseRef.current === "starting") stopSoon.current = true;
      return;
    }
    recording.current = undefined;
    setPhase("transcribing");
    try {
      const pcm = await current.finish();
      if (pcm.length >= MIN_SAMPLES) insert(await window.studio.dictation.transcribe(pcm));
    } catch (failure) {
      setError(`Dictation failed: ${(failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    } finally {
      setPhase("idle");
    }
  }, [insert]);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" || !ready || disabled) return;
    setError(undefined);
    setPhase("starting");
    stopSoon.current = false;
    window.studio.dictation.warm();
    try {
      recording.current = await Recording.start();
    } catch (failure) {
      setPhase("idle");
      setError(`The microphone is not available: ${(failure as Error).message}`);
      return;
    }
    setStartedAt(Date.now());
    setPhase("recording");
    limit.current = setTimeout(() => void stop(), MAX_SECONDS * 1000);
    if (stopSoon.current) void stop();
  }, [ready, disabled, stop]);

  const cancel = useCallback(() => {
    clearTimeout(limit.current);
    stopSoon.current = false;
    recording.current?.cancel();
    recording.current = undefined;
    if (phaseRef.current === "recording" || phaseRef.current === "starting") setPhase("idle");
  }, []);

  const toggle = useCallback(() => {
    if (phaseRef.current === "recording" || phaseRef.current === "starting") void stop();
    else void start();
  }, [start, stop]);

  // Right Option, for the active chat's composer.
  const latest = useRef({ start, stop, cancel });
  latest.current = { start, stop, cancel };
  useEffect(() => {
    if (!on || !active) return;
    const gesture = new RightOptionGesture(
      (action) => void latest.current[action](),
      () => phaseRef.current === "starting" || phaseRef.current === "recording",
    );
    const elsewhere = () => document.activeElement !== area.current && editable(document.activeElement);
    const keydown = (event: KeyboardEvent) => {
      if (event.code === "AltRight" && elsewhere()) return;
      gesture.keydown(event);
    };
    const keyup = (event: KeyboardEvent) => gesture.keyup(event);
    const blur = () => gesture.blur();
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", blur);
    return () => {
      gesture.dispose();
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
    };
  }, [on, active, area]);

  // Leaving the chat, or turning dictation off, drops a recording on its way.
  useEffect(() => () => cancel(), [cancel]);
  useEffect(() => {
    if (!on) cancel();
  }, [on, cancel]);

  const option = navigator.userAgent.includes("Mac") ? "Right Option" : "Right Alt";
  const title =
    status?.phase === "downloading"
      ? `Dictation: downloading the speech model… ${Math.round((status.progress ?? 0) * 100)}%`
      : status?.phase === "error"
        ? `Dictation: ${status.error ?? "the speech model failed"} (Settings > Agent has Retry)`
        : phase === "recording"
          ? `Stop and write it down (${option})`
          : `Dictate (tap ${option}, or hold it while you speak)`;
  return { on, phase, ready, title, error, startedAt, toggle };
}

/** The mic button: grey while idle, red with the elapsed time while recording, a spinner while transcribing. */
export function DictationButton({ dictation }: { dictation: ComposerDictation }) {
  const { phase, ready, title, error, startedAt, toggle } = dictation;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const busy = phase === "starting" || phase === "transcribing";
  return (
    <>
      <button
        type="button"
        title={title}
        aria-label={phase === "recording" ? "Stop dictation" : "Dictate"}
        aria-pressed={phase === "recording"}
        disabled={!ready && phase === "idle"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        data-testid="composer-dictate"
        className={
          phase === "recording"
            ? "flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-bad/15 px-2 font-mono text-[11.5px] text-bad"
            : "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
        }
      >
        {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Mic size={15} />}
        {phase === "recording" && (
          <>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bad" aria-hidden />
            {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
          </>
        )}
      </button>
      {error && (
        <span className="min-w-0 truncate text-[12px] text-bad" title={error} data-testid="composer-dictate-error">
          {error}
        </span>
      )}
    </>
  );
}
