import { X } from "../renderer/src/components/icons";
import { createStore, useStore } from "../renderer/src/lib/store";

interface Toast {
  id: number;
  text: string;
  level: "info" | "warning" | "error";
}

const store = createStore<Toast[]>([]);
let seq = 0;

export function toast(text: string, level: Toast["level"] = "info"): void {
  const id = ++seq;
  // Two at most: a third pushes the oldest out, so a burst of actions never builds a wall over the screen.
  store.set((toasts) => [...toasts.slice(-1), { id, text, level }]);
  setTimeout(() => dismiss(id), level === "error" ? 8000 : 4500);
}

const dismiss = (id: number) => store.set((toasts) => toasts.filter((t) => t.id !== id));

export function Toasts() {
  const toasts = useStore(store, (state) => state);
  if (!toasts.length) return null;
  return (
    // Under the screen's Header (Screens.tsx: 3rem and a hairline below the inset), like the connection banner, so the
    // back button and the title stay in reach while a toast is up.
    <div className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4" style={{ top: "calc(env(safe-area-inset-top) + 3rem + 1px + 8px)" }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex max-w-full items-start gap-2 rounded-xl border bg-panel px-3.5 py-2.5 text-[13.5px] shadow-[0_8px_24px_-8px_rgb(0_0_0/0.6)] ${t.level === "error" ? "border-bad/50 text-bad" : t.level === "warning" ? "border-warn/50 text-warn" : "border-line-strong text-fg"}`}
        >
          <span className="min-w-0 break-words">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 p-0.5 text-faint">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
