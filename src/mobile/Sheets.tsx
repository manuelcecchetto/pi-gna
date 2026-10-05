// Bottom sheets for the phone's composer: the generic sheet, and the model and thinking pickers on it.
import { Check, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { fuzzyFilter } from "../renderer/src/lib/fuzzy";
import type { Model, ThinkingLevel } from "../shared/protocol";

export function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  return (
    // As tall as the visible area (viewport.ts), not the screen: with the keyboard up the sheet sits on it instead of
    // behind it. iOS would pan the page to the field, but viewport.ts holds the page still.
    <div className="fixed inset-x-0 top-0 z-40 flex h-[var(--app-height,100%)] flex-col justify-end bg-black/50" onClick={onClose} data-testid={testId}>
      <div
        role="dialog"
        aria-label={title}
        className="sheet-panel concentric-sheet flex max-h-[80%] flex-col overflow-hidden rounded-t-[28px] border-t border-line-strong bg-panel px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div aria-hidden className="mx-auto mt-2 h-[5px] w-9 shrink-0 rounded-full bg-line-strong" />
        <div className="grid shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center px-2 pt-1.5 pb-2">
          <span />
          <span className="truncate text-center text-[17px] font-semibold text-fg">{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="grid h-11 w-11 place-items-center">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-raised text-muted">
              <X size={16} strokeWidth={2.5} />
            </span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const row = (active: boolean) => `flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl px-4 text-left active:bg-raised ${active ? "text-accent" : "text-fg"}`;

export function ModelSheet({ models, current, onPick, onClose }: { models: Model[]; current?: Model; onPick: (model: Model) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = fuzzyFilter(models, query, (m: Model) => `${m.provider}/${m.id} ${m.name}`, 200);
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
              <span className="min-w-0 truncate text-[15px]">{model.name}</span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">
                {model.provider}
                {active && <Check size={15} className="text-accent" />}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

export function ThinkingSheet({ levels, current, onPick, onClose }: { levels: ThinkingLevel[]; current?: ThinkingLevel; onPick: (level: ThinkingLevel) => void; onClose: () => void }) {
  return (
    <Sheet title="Thinking" onClose={onClose} testId="thinking-sheet">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {levels.map((level) => (
          <button key={level} type="button" onClick={() => onPick(level)} className={`${row(level === current)} text-[16px]`} data-testid="thinking-option">
            {level}
            {level === current && <Check size={15} className="text-accent" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
