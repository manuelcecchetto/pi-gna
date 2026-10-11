// The agent's questions (ask_user, src/shared/ask.ts) in place of the composer: one question at a time, the stack
// sliding to the next and the card's height following, defaults preselected. The Continue/Send button's fill is the
// countdown that sends the defaults; touching the card stops it for every client (pauseDialog).
import { type CSSProperties, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AskQuestion, type AskReply, countdownProgress } from "../../../shared/ask";
import type { ExtensionUiDialog } from "../../../shared/protocol";
import { useChatActions } from "../lib/chat-ui";
import { Check, ChevronDown, ChevronUp, X } from "./icons";

export type QuestionsDialog = Extract<ExtensionUiDialog, { method: "questions" }>;

export const questionsOf = (dialogs: ExtensionUiDialog[]): QuestionsDialog | undefined => dialogs.find((dialog): dialog is QuestionsDialog => dialog.method === "questions");

/** A single-choice pick moves on after this long, so the choice is seen landing. */
const ADVANCE_MS = 320;
/** A mouse counts as the user's hand once it moved this far (CSS px) over the card. */
const HOVER_PX = 8;
/** How long a first Esc keeps the stop armed for the second, as in the composer. */
const ESC_ARM_MS = 2500;

interface Draft {
  picks: number[];
  text: string;
  skipped?: boolean;
}

/** A question's rows, top to bottom: its options, then the free-text field. */
const rowsOf = (item: HTMLElement | null | undefined): HTMLElement[] => [...(item?.querySelectorAll<HTMLElement>("[data-ask-row]") ?? [])];

const fresh = (question: AskQuestion): Draft => ({ picks: question.defaultPicks, text: question.defaultText ?? "" });
const answered = (draft: Draft) => draft.picks.length > 0 || draft.text.trim() !== "";

/**
 * The countdown as a CSS fill (`--ask-fill`, styles.css): a running one is an animation started part-way through, so it
 * moves without re-rendering; a paused one stands where it stopped.
 */
export function countdownFill(dialog: { timeout?: number; deadline?: number; left?: number }, now = Date.now()): CSSProperties | undefined {
  if (!dialog.timeout) return undefined;
  const progress = countdownProgress(dialog, now) ?? 0;
  if (dialog.deadline !== undefined) return { animation: `ask-fill ${dialog.timeout}ms linear ${-Math.round(progress * dialog.timeout)}ms forwards` };
  return { "--ask-fill": `${(progress * 100).toFixed(2)}%` } as CSSProperties;
}

/** `onStop` stops the run on a second Esc, as the composer the card replaces does; without it Esc does nothing. */
export const QuestionsCard = memo(function QuestionsCard({ handle, dialog, onStop }: { handle: string; dialog: QuestionsDialog; onStop?: () => void }) {
  const { respondDialog, pauseDialog } = useChatActions();
  const { questions } = dialog;
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(fresh));
  const [sending, setSending] = useState(false);
  const [direction, setDirection] = useState<"up" | "down">("down");
  const advanceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const paused = useRef(false);
  const [armed, setArmed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // The composer it replaced had the focus, which fell to the page: take it, so Esc reaches the card. Focus alone does
  // not stop the countdown.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, []);
  // Moving to another question takes the keyboard along: focus lands on its picked (or first) row, unless the focus is
  // somewhere else on the page.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !root.current?.contains(focused)) return;
    const rows = rowsOf(items.current[step]);
    (rows.find((row) => row.getAttribute("aria-checked") === "true") ?? rows[0])?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ESC_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const last = step === questions.length - 1;
  const draft = drafts[step] ?? { picks: [], text: "" };
  const running = dialog.deadline !== undefined;

  /** Any touch stops the countdown, once. */
  const touch = () => {
    if (paused.current || !running) return;
    paused.current = true;
    pauseDialog(handle, dialog.id);
  };
  // Hovering stops it too, but only a mouse that moves over the card: a pointer resting where the card appeared (the
  // user away from the desk) gets a pointer event from the layout alone, and must not hold the defaults back.
  const hoverFrom = useRef<{ x: number; y: number }>(undefined);
  const hover = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const from = (hoverFrom.current ??= { x: event.screenX, y: event.screenY });
    if (Math.hypot(event.screenX - from.x, event.screenY - from.y) >= HOVER_PX) touch();
  };

  const send = (next: Draft[]) => {
    clearTimeout(advanceTimer.current);
    setSending(true);
    const replies: AskReply[] = questions.map((question, index) => {
      const d = next[index] ?? fresh(question);
      return d.skipped ? { id: question.id, skipped: true } : { id: question.id, picks: d.picks, text: d.text.trim() };
    });
    void respondDialog(handle, { type: "extension_ui_response", id: dialog.id, value: JSON.stringify({ replies }) }).finally(() => setSending(false));
  };

  const goTo = (index: number) => {
    clearTimeout(advanceTimer.current);
    const next = Math.min(Math.max(index, 0), questions.length - 1);
    setDirection(next < step ? "up" : "down");
    setStep(next);
  };

  const advance = (next: Draft[] = drafts) => (last ? send(next) : goTo(step + 1));

  const update = (index: number, change: Partial<Draft>): Draft[] => {
    const next = drafts.map((d, i) => (i === index ? { ...d, ...change, skipped: false } : d));
    setDrafts(next);
    return next;
  };

  const pick = (option: number) => {
    touch();
    const question = questions[step];
    if (!question) return;
    if (question.multi) {
      update(step, { picks: draft.picks.includes(option) ? draft.picks.filter((p) => p !== option) : [...draft.picks, option].sort((a, b) => a - b) });
      return;
    }
    const next = update(step, { picks: [option], text: "" });
    clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => advance(next), ADVANCE_MS);
  };

  const skip = () => {
    touch();
    const next = drafts.map((d, i) => (i === step ? { ...fresh(questions[i] as AskQuestion), skipped: true } : d));
    setDrafts(next);
    advance(next);
  };

  // The viewport shows one question of the stacked track: its height and the track's offset follow the current one.
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const [box, setBox] = useState<{ height: number; y: number }>();
  const measured = useRef(false);
  useLayoutEffect(() => {
    const item = items.current[step];
    if (!item) return;
    const measure = () => setBox({ height: item.offsetHeight, y: item.offsetTop });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(item);
    return () => observer.disconnect();
  }, [step]);
  useLayoutEffect(() => {
    if (box) measured.current = true;
  }, [box]);
  const slide = measured.current ? "360ms cubic-bezier(0.22, 1, 0.36, 1)" : undefined;

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="ask-card relative outline-none"
      data-testid="questions"
      onPointerMove={hover}
      onPointerDown={touch}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        touch();
        if (event.key === "Escape" && onStop) {
          event.preventDefault();
          if (armed) {
            setArmed(false);
            onStop();
          } else setArmed(true);
          return;
        }
        const typing = (event.target as HTMLElement).tagName === "INPUT";
        // ⌥↑/⌥↓ change question; ↑/↓ move between its rows (the free-text field is the last); 1-9 pick an option.
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          if (event.altKey) return goTo(step + delta);
          const rows = rowsOf(items.current[step]);
          const at = rows.indexOf(document.activeElement as HTMLElement);
          rows[at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(Math.max(at + delta, 0), rows.length - 1)]?.focus();
          return;
        }
        if (!typing && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const option = Number(event.key) - 1;
          if (option < (questions[step]?.options.length ?? 0)) {
            event.preventDefault();
            rowsOf(items.current[step])[option]?.focus();
            pick(option);
          }
          return;
        }
        // Enter continues from the free-text field only (option buttons click on Enter): a key meant for the composer
        // as the card appeared must not send the defaults.
        if (event.key !== "Enter" || event.shiftKey || !typing) return;
        event.preventDefault();
        if (answered(draft) && !sending) advance();
      }}
    >
      <button
        type="button"
        aria-label="Dismiss the questions"
        title="Dismiss: the agent gets no answer"
        onClick={() => void respondDialog(handle, { type: "extension_ui_response", id: dialog.id, cancelled: true })}
        className="absolute top-2.5 right-2.5 z-10 grid size-6 place-items-center rounded-md text-faint hover:bg-raised hover:text-fg touch:size-9"
      >
        <X size={14} />
      </button>

      <div className="overflow-hidden px-4 pt-3.5" style={{ height: box && box.height + 14, transition: slide && `height ${slide}` }} aria-live="polite">
        <div className="flex flex-col gap-6" style={{ transform: `translate3d(0, ${-(box?.y ?? 0)}px, 0)`, transition: slide && `transform ${slide}` }}>
          {questions.map((question, index) => {
            const active = index === step;
            const d = drafts[index] ?? fresh(question);
            return (
              <div
                key={question.id}
                ref={(el) => {
                  items.current[index] = el;
                }}
                inert={!active}
                aria-hidden={!active}
                style={{ opacity: active ? 1 : 0, transition: slide && `opacity ${slide}` }}
              >
                <div className="selectable pr-8 text-[14px] font-medium text-fg touch:text-[15.5px]">{question.prompt}</div>
                <div className="mt-2 flex flex-col gap-0.5">
                  {question.options.map((option, i) => {
                    const on = d.picks.includes(i);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={question.multi ? "checkbox" : "radio"}
                        aria-checked={on}
                        data-ask-row
                        onClick={() => pick(i)}
                        className="group flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none hover:bg-raised/70 focus-visible:bg-raised/70 touch:py-2.5"
                      >
                        <span
                          className={`mt-px grid size-4 shrink-0 place-items-center transition-colors ${question.multi ? "rounded-[5px]" : "rounded-full"} ${on ? "bg-fg text-canvas" : "text-transparent shadow-[inset_0_0_0_1.5px_var(--line-strong)]"}`}
                        >
                          {question.multi ? <Check size={11} strokeWidth={3} /> : <span className={`size-1.5 rounded-full bg-canvas transition-transform ${on ? "scale-100" : "scale-0"}`} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`text-[13px] touch:text-[15px] ${on ? "text-fg" : "text-muted group-hover:text-fg group-focus-visible:text-fg"}`}>{option.label}</span>
                          {question.defaultPicks.includes(i) && <span className="ml-2 rounded-full border border-line px-1.5 py-px align-[1px] text-[10.5px] text-faint">default</span>}
                          {option.description && <span className="mt-0.5 block text-[12px] text-faint touch:text-[13px]">{option.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {question.allowOther && (
                    <input
                      data-ask-row
                      value={d.text}
                      onChange={(event) => {
                        touch();
                        update(index, question.multi ? { text: event.target.value } : { text: event.target.value, picks: event.target.value.trim() ? [] : d.picks });
                      }}
                      placeholder={question.options.length ? "Something else…" : "Your answer…"}
                      aria-label="Your own answer"
                      className={`selectable w-full rounded-lg bg-transparent py-1.5 text-[13px] text-fg outline-none placeholder:text-faint touch:py-2.5 touch:text-[16px] ${question.options.length ? "pl-[34px]" : "border border-line bg-sunken px-2.5 focus:border-accent/60"}`}
                    />
                  )}
                  {question.defaultText !== undefined && d.text !== question.defaultText && (
                    <span className="pl-[34px] text-[11px] text-faint">default: {question.defaultText}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 px-2 pb-2">
        <div className="flex items-center gap-0.5 text-faint">
          {questions.length > 1 && (
            <>
              <button type="button" aria-label="Previous question" disabled={step === 0} onClick={() => goTo(step - 1)} className="grid size-6 place-items-center rounded-md enabled:hover:text-fg disabled:opacity-30 touch:size-9">
                <ChevronUp size={14} />
              </button>
              <span className="inline-flex overflow-hidden font-mono text-[11.5px] tabular-nums" aria-label={`Question ${step + 1} of ${questions.length}`}>
                <span key={step} className={direction === "down" ? "ask-roll-down" : "ask-roll-up"}>
                  {step + 1}
                </span>
                <span>&nbsp;/ {questions.length}</span>
              </span>
              <button type="button" aria-label="Next question" disabled={last} onClick={() => goTo(step + 1)} className="grid size-6 place-items-center rounded-md enabled:hover:text-fg disabled:opacity-30 touch:size-9">
                <ChevronDown size={14} />
              </button>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {armed ? <span className="mr-1 text-[11.5px] text-faint">Esc again to stop</span> : dialog.timeout && !running && <span className="mr-1 text-[11.5px] text-faint">Paused</span>}
          <button type="button" onClick={skip} disabled={sending} title="Take the default" className="rounded-full bg-raised px-3 py-1 text-[12.5px] font-medium text-fg hover:opacity-90 touch:px-4 touch:py-2 touch:text-[14px]">
            Skip
          </button>
          <button
            type="button"
            disabled={!answered(draft) || sending}
            onClick={() => advance()}
            title={running ? "The defaults go when this fills up; touch the card to stop it" : undefined}
            data-countdown={running ? "running" : dialog.timeout ? "paused" : undefined}
            className={`ask-send rounded-full px-3 py-1 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-50 touch:px-4 touch:py-2 touch:text-[14px] ${running ? "ask-countdown" : "bg-accent"}`}
            style={running ? countdownFill(dialog) : undefined}
          >
            {last ? "Send" : "Continue"} <span className="opacity-60">⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
});
