import { type CSSProperties, type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { type AnsiStyle, parseAnsi } from "../lib/ansi";
import { formatClock, formatDuration } from "../lib/format";
import { clampPanel, type PanelBounds } from "../lib/layout";

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

/** An on/off switch. */
export function Switch({ on, onChange, disabled, title }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={title ?? (on ? "Turn off" : "Turn on")}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-accent" : "border border-line bg-raised"}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

/**
 * Hold ⌘ to see ⌘1…⌘9 on the first nine `targets` (DigitHint), and press one to pick it, as in Codex. Returns whether
 * the hints show. By key position (Digit1…), so it works on any keyboard layout.
 */
export function useCommandDigits(targets: readonly (() => void)[], enabled = true): boolean {
  const [held, setHeld] = useState(false);
  const pick = useEffectEvent((digit: number): boolean => {
    const target = targets[digit - 1];
    target?.();
    return target !== undefined;
  });
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      setHeld(false);
    };
    const down = (event: KeyboardEvent) => {
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey;
      if (event.key === "Meta") {
        clearTimeout(timer);
        if (plain && !event.repeat) timer = setTimeout(() => setHeld(true), 300);
      } else if (event.metaKey && plain && /^Digit[1-9]$/.test(event.code)) {
        if (!event.defaultPrevented && pick(Number(event.code.slice(5)))) event.preventDefault();
      } else hide(); // ⌘ with another key is a shortcut, not a look at the hints
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || !event.metaKey) hide();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", hide);
    };
  }, [enabled]);
  return held && enabled;
}

/** "⌘3" on a row while ⌘ is held (useCommandDigits). */
export function DigitHint({ digit }: { digit: number }) {
  return <span className="shrink-0 rounded border border-line-strong bg-panel px-1 font-mono text-[10.5px] leading-[16px] text-muted">⌘{digit}</span>;
}

const HANDLE_EDGE = {
  left: "inset-y-0 left-0 w-1.5 cursor-col-resize",
  right: "inset-y-0 right-0 w-1.5 cursor-col-resize",
  top: "inset-x-0 top-0 h-1.5 cursor-row-resize",
};

/**
 * The edge of a panel you drag to resize it: put it inside the panel (positioned), on the side the panel grows from.
 * `giver` is what gives way as the panel grows; the drag stops before it gets smaller than `keep`. Double-click resets.
 */
export function ResizeHandle({
  edge,
  bounds,
  giver,
  keep,
  onResize,
}: {
  edge: "left" | "right" | "top";
  bounds: PanelBounds;
  giver: () => Element | null | undefined;
  keep: number;
  /** A new size while dragging; `done` once it is let go (the time to remember it). */
  onResize: (size: number, done: boolean) => void;
}) {
  const drag = useRef<{ from: number; size: number; room?: number; last: number }>(undefined);
  const [dragging, setDragging] = useState(false);
  const vertical = edge === "top";
  const along = (event: { clientX: number; clientY: number }) => (vertical ? event.clientY : event.clientX);
  const extent = (element: Element | null | undefined) => {
    const box = element?.getBoundingClientRect();
    return box && (vertical ? box.height : box.width);
  };

  const finish = () => {
    if (!drag.current) return;
    onResize(drag.current.last, true);
    drag.current = undefined;
    setDragging(false);
  };

  return (
    <div
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        // Start from the size on screen, which the page may have squeezed below the remembered one.
        const size = extent(event.currentTarget.parentElement) ?? bounds.fallback;
        const room = extent(giver());
        drag.current = { from: along(event), size, room: room === undefined ? undefined : size + room - keep, last: size };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const moved = along(event) - current.from;
        current.last = clampPanel(current.size + (edge === "right" ? moved : -moved), bounds, current.room);
        onResize(current.last, false);
      }}
      onPointerUp={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => onResize(bounds.fallback, true)}
      className={`absolute z-10 transition-colors hover:bg-accent/40 ${HANDLE_EDGE[edge]} ${dragging ? "bg-accent/50" : ""}`}
    />
  );
}
