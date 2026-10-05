// Bottom sheets for the phone's composer: the generic sheet, and the model and thinking pickers on it.
import { Check, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { fuzzyFilter } from "../renderer/src/lib/fuzzy";
import type { Model, ThinkingLevel } from "../shared/protocol";

export function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/50" onClick={onClose} data-testid={testId}>
      <div
        role="dialog"
        aria-label={title}
        className="concentric-sheet flex max-h-[80%] flex-col rounded-t-2xl border-t border-line-strong bg-panel pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[15px] font-medium text-fg">{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-muted">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const row = (active: boolean) => `flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-3 text-left ${active ? "text-accent" : "text-fg"}`;

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
          className="w-full rounded-xl bg-sunken px-3 py-2.5 text-[16px] text-fg outline-none placeholder:text-faint"
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
          <button key={level} type="button" onClick={() => onPick(level)} className={`${row(level === current)} font-mono text-[14px]`} data-testid="thinking-option">
            {level}
            {level === current && <Check size={15} className="text-accent" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
