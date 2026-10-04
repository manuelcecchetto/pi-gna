// The controls of the Settings page's sections.
import { ChevronDown, RotateCcw, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Model } from "../../../shared/protocol";
import { fuzzyFilter } from "../lib/fuzzy";
import { toast, useApp } from "../state/app";
import { Popover } from "./primitives";

export function Card({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="mb-2 text-[13px] font-medium text-fg">{title}</h2>}
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">{children}</div>
      {note && <p className="mt-2 text-[12px] leading-relaxed text-faint">{note}</p>}
    </section>
  );
}

export function Row({ title, about, onReset, children }: { title: string; about?: ReactNode; onReset?: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{title}</div>
        {about && <div className="mt-0.5 text-[12px] leading-relaxed text-faint">{about}</div>}
      </div>
      {onReset && (
        <button type="button" title="Back to the default" onClick={onReset} className="shrink-0 rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
          <RotateCcw size={12} />
        </button>
      )}
      {children}
    </div>
  );
}

export function Button({ onClick, primary, disabled, title, children }: { onClick: () => void; primary?: boolean; disabled?: boolean; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] disabled:cursor-default disabled:opacity-50 ${primary ? "border-accent bg-accent font-medium text-white enabled:hover:opacity-90" : "border-line text-fg enabled:hover:bg-raised"}`}
    >
      {children}
    </button>
  );
}

/** A button for what is hard to take back: the first click asks, a second within three seconds does it. */
export function ConfirmButton({ label, confirm, title, onConfirm }: { label: string; confirm: string; title?: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        setArmed(!armed);
        if (armed) onConfirm();
      }}
      className={`shrink-0 rounded-lg border px-2.5 py-1 text-[12px] ${armed ? "border-bad/50 bg-bad/10 text-bad" : "border-line text-muted hover:bg-raised hover:text-fg"}`}
    >
      {armed ? confirm : label}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, labels, onChange }: { value: string; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void }) {
  return (
    <div className="flex shrink-0 rounded-lg border border-line p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => option !== value && onChange(option)}
          className={`rounded-md px-2.5 py-0.5 text-[12px] ${option === value ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

export function Choice<T extends string>({ value, options, mono, onChange }: { value: string; options: readonly T[]; mono?: boolean; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative shrink-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-raised">
        <span className={mono ? "font-mono" : ""}>{value}</span>
        <ChevronDown size={12} className="text-faint" />
      </button>
      <Popover open={open} onClose={close} className="top-full right-0 mt-1 w-36 p-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setOpen(false);
              if (option !== value) onChange(option);
            }}
            className={`block w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-raised ${mono ? "font-mono" : ""} ${option === value ? "text-accent" : "text-fg"}`}
          >
            {option}
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** One of the models pi has (state.models, listed once a chat started). */
export function ModelChoice({ value, unset = "Not set", onChange }: { value?: { provider?: string; id: string }; unset?: string; onChange: (model: Model) => void }) {
  const models = useApp((state) => state.models);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const filtered = fuzzyFilter(models, query, (model: Model) => `${model.provider}/${model.id} ${model.name}`, 200);
  const same = (model: Model) => model.id === value?.id && (value.provider === undefined || model.provider === value.provider);
  const known = models.find(same);
  const missing = value && models.length > 0 && !known;
  const choose = (model: Model) => {
    setOpen(false);
    setQuery("");
    onChange(model);
  };
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={missing ? "pi does not have this model now" : value ? `${value.provider ? `${value.provider}/` : ""}${value.id}` : undefined}
        className="flex max-w-64 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-raised"
      >
        {missing && <TriangleAlert size={12} className="shrink-0 text-warn" />}
        <span className="truncate">{value ? (known?.name ?? value.id) : <span className="text-muted">{unset}</span>}</span>
        {value?.provider && <span className="shrink-0 font-mono text-[10.5px] text-faint">{value.provider}</span>}
        <ChevronDown size={12} className="shrink-0 text-faint" />
      </button>
      <Popover open={open} onClose={close} className="top-full right-0 mt-1 w-80 p-1">
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
          {models.length === 0 && <p className="px-2.5 py-2 text-[12px] text-faint">pi lists its models once a chat has started.</p>}
          {filtered.map((model) => (
            <button
              key={`${model.provider}/${model.id}`}
              type="button"
              onClick={() => choose(model)}
              className={`flex w-full items-baseline justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-raised ${value && model.id === value.id && model.provider === (value.provider ?? known?.provider) ? "text-accent" : "text-fg"}`}
            >
              <span className="truncate text-[12.5px]">{model.name}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-faint">{model.provider}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

/** A whole number, saved when you leave the field or press Enter. */
export function NumberField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number(text.replace(/[\s_,]/g, ""));
    if (text.trim() === "" || !Number.isSafeInteger(next) || next < min || next > max) {
      toast(`Enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}`, "warning");
      setText(String(value));
    } else if (next !== value) onCommit(next);
  };
  return (
    <input
      inputMode="numeric"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Escape") {
          event.stopPropagation();
          setText(String(value));
          event.currentTarget.blur();
        }
      }}
      className="w-24 shrink-0 rounded-lg border border-line bg-transparent px-2 py-1 text-right font-mono text-[12px] text-fg outline-none focus:border-line-strong"
    />
  );
}
