import { useEffect } from "react";
import { Ansi } from "./components/primitives";
import { SessionPane } from "./components/SessionPane";
import { Sidebar } from "./components/Sidebar";
import { boot, dismissToast, newSession, store, toggleExpandAll, useApp } from "./state/app";

export function App() {
  useEffect(() => {
    boot();
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        toggleExpandAll();
      } else if (event.metaKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const { active, sessions } = store.get();
        newSession((active && sessions[active]?.cwd) || window.studio.launchCwd || window.studio.homeDir);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const session = useApp((state) => (state.active ? state.sessions[state.active] : undefined));

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 border-l border-line bg-canvas">
        {session ? (
          <SessionPane key={session.handle} session={session} />
        ) : (
          <div className="drag grid h-full place-items-center text-[13px] text-faint">Pick a session or start a new one (⌘N)</div>
        )}
      </main>
      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useApp((state) => state.toasts);
  return (
    <div className="pointer-events-none fixed top-14 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line-strong bg-panel px-3 py-2.5 text-left text-[12.5px] text-fg shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]"
        >
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${toast.level === "error" ? "bg-bad" : toast.level === "warning" ? "bg-warn" : "bg-accent"}`} />
          <span className="selectable min-w-0 break-words">
            <Ansi text={toast.text} />
          </span>
        </button>
      ))}
    </div>
  );
}
