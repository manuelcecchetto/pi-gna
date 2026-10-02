import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type AnsiStyle, parseAnsi } from "../lib/ansi";
import { formatClock, formatDuration } from "../lib/format";

export function Ansi({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {spans.map((span, index) => (
        <span key={index} style={ansiStyle(span.style)}>
          {span.text}
        </span>
      ))}
    </>
  );
}

function ansiStyle(style: AnsiStyle): CSSProperties | undefined {
  if (!style.color && !style.background && !style.bold && !style.dim && !style.italic && !style.underline) return undefined;
  return {
    color: style.color,
    background: style.background,
    fontWeight: style.bold ? 600 : undefined,
    opacity: style.dim ? 0.6 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
  };
}

export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export function Elapsed({ since, plain = false }: { since: number; plain?: boolean }) {
  const now = useNow(plain ? 1000 : 100);
  const text = plain ? formatClock(now - since) : formatDuration(now - since);
  return <span className={plain ? "tabular-nums" : "font-mono text-[11.5px] text-faint tabular-nums"}>{text}</span>;
}


/** Click-outside popover anchored to its parent (which must be `relative`). */
export function Popover({
  open,
  onClose,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`absolute z-30 rounded-xl border border-line-strong bg-panel shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line px-1 font-mono text-[10px] text-faint">{children}</kbd>;
}
