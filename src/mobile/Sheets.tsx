// Bottom sheets for the phone's composer: the generic sheet, and the model sheet (model, thinking, fast mode) on it.
import { Brain, Check, X, Zap } from "../renderer/src/components/icons";
import { Switch } from "../renderer/src/components/primitives";
import { LazyProviderLogo } from "../renderer/src/components/LazyProviderLogo";
import { sharedNames } from "../shared/fast";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { fuzzyFilter } from "../renderer/src/lib/fuzzy";
import type { Model, ThinkingLevel } from "../shared/protocol";

/** How far down (px) or how fast (px/ms) a release must be to dismiss the sheet; less springs it back. */
const DISMISS_PX = 96;
const DISMISS_SPEED = 0.6;

/**
 * Drag the sheet by its grabber and title row, as an iOS sheet: it follows the finger down (and resists going up),
 * and a long or quick pull dismisses it; the backdrop fades with it. Inline styles, so a drag never re-renders.
 */
function useSheetDrag(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const place = (dy: number, animate: boolean) => {
    const sheet = panel.current;
    if (!sheet) return;
    sheet.style.transition = animate ? "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)" : "none";
    sheet.style.transform = dy ? `translateY(${dy}px)` : "";
    if (backdrop.current) {
      backdrop.current.style.transition = animate ? "background-color 220ms" : "none";
      backdrop.current.style.backgroundColor = `rgb(0 0 0 / ${0.5 * Math.max(0, 1 - dy / sheet.offsetHeight)})`;
    }
  };
  // The finger is followed on the window, as the ATP graph does: no pointer capture to lose.
  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const { pointerId, clientY } = event;
    let dy = 0;
    let at = event.timeStamp;
    let speed = 0;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const raw = next.clientY - clientY;
      // Up only a little, with resistance: the sheet is already as tall as its content.
      const to = raw > 0 ? raw : -Math.sqrt(-raw) * 2;
      const dt = next.timeStamp - at;
      if (dt > 0) speed = (to - dy) / dt;
      dy = to;
      at = next.timeStamp;
      place(dy, false);
    };
    const end = (last: PointerEvent) => {
      if (last.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dy > DISMISS_PX || (dy > 0 && speed > DISMISS_SPEED)) {
        place(panel.current?.offsetHeight ?? 600, true);
        setTimeout(onClose, 200);
      } else place(0, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return { panel, backdrop, onPointerDown };
}

export function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  const { panel, backdrop, onPointerDown } = useSheetDrag(onClose);
  return (
    // As tall as the visible area (viewport.ts), not the screen: with the keyboard up the sheet sits on it instead of
    // behind it. iOS would pan the page to the field, but viewport.ts holds the page still.
    <div ref={backdrop} className="fixed inset-x-0 top-0 z-40 flex h-[var(--app-height,100%)] flex-col justify-end bg-black/50" onClick={onClose} data-testid={testId}>
      <div
        ref={panel}
        role="dialog"
        aria-label={title}
        className="sheet-panel concentric-sheet flex max-h-[80%] flex-col overflow-hidden rounded-t-[28px] border-t border-line-strong bg-panel px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 touch-none" onPointerDown={onPointerDown} data-testid="sheet-grabber">
          <div aria-hidden className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-line-strong" />
          <div className="grid grid-cols-[2.75rem_1fr_2.75rem] items-center px-2 pt-1.5 pb-2">
            <span />
            <span className="truncate text-center text-[17px] font-semibold text-fg">{title}</span>
            <button type="button" aria-label="Close" onClick={onClose} className="grid h-11 w-11 place-items-center">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-raised text-muted">
                <X size={16} strokeWidth={2.5} />
              </span>
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const row = (active: boolean) => `flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl px-4 text-left active:bg-raised ${active ? "text-accent" : "text-fg"}`;

/**
 * Model, thinking level and fast mode in one sheet, as the desktop's model menu: the list in the middle, the level and
 * the Fast switch (GPT models only) at the bottom, under the thumb. Picking keeps the sheet open to set the rest.
 */
export function ModelSheet({
  models,
  current,
  levels,
  level,
  fast,
  onPick,
  onLevel,
  onFast,
  onClose,
}: {
  models: Model[];
  current?: Model;
  levels?: ThinkingLevel[];
  level?: ThinkingLevel;
  /** Fast mode's state, or undefined when the model is not a GPT one. */
  fast?: boolean;
  onPick: (model: Model) => void;
  onLevel?: (level: ThinkingLevel) => void;
  onFast?: (on: boolean) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = fuzzyFilter(models, query, (m: Model) => `${m.provider}/${m.id} ${m.name}`, 200);
  const shared = useMemo(() => sharedNames(models), [models]);
  return (
    <Sheet title="Model" onClose={onClose} testId="model-sheet">
      <div className="px-4 pb-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full rounded-full bg-sunken px-4 py-2.5 text-[16px] text-fg outline-none placeholder:text-faint"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && <div className="px-3 py-4 text-[13.5px] text-faint">{models.length ? "No model matches." : "Loading models…"}</div>}
        {filtered.map((model) => {
          const active = model.id === current?.id && model.provider === current?.provider;
          return (
            <button key={`${model.provider}/${model.id}`} type="button" onClick={() => onPick(model)} className={row(active)} data-testid="model-option">
              <span className="flex min-w-0 items-center gap-3">
                <LazyProviderLogo id={model.provider} size={22} />
                <span className="min-w-0 truncate text-[15px]">{model.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">
                {shared.has(model.name) && model.provider}
                {active && <Check size={15} className="text-accent" />}
              </span>
            </button>
          );
        })}
      </div>
      {(levels || fast !== undefined) && (
        <div className="flex shrink-0 flex-col gap-3 border-t border-line px-4 pt-3 pb-2">
          {levels && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-1.5 text-[13px] text-muted">
                <Brain size={14} className="text-faint" />
                Thinking
              </span>
              <div className="flex gap-1 overflow-x-auto rounded-full bg-sunken p-1">
                {levels.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onLevel?.(option)}
                    aria-pressed={option === level}
                    className={`h-9 shrink-0 grow rounded-full px-3 font-mono text-[13px] ${option === level ? "bg-raised text-fg" : "text-muted active:text-fg"}`}
                    data-testid="thinking-option"
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}
          {fast !== undefined && (
            <div className="flex min-h-11 items-center gap-3" data-testid="fast-row">
              <Zap size={18} className={`shrink-0 ${fast ? "text-warn" : "text-faint"}`} fill={fast ? "currentColor" : "none"} />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] text-fg">Fast</div>
                <div className="text-[12.5px] text-faint">Priority processing, 2x price</div>
              </div>
              <Switch on={fast} onChange={(on) => onFast?.(on)} title={fast ? "Turn fast mode off" : "Turn fast mode on"} />
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
