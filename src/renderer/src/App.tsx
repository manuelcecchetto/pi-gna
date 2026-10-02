import { useEffect, useRef } from "react";
import { BrowserPane } from "./components/BrowserPane";
import { PiLogo } from "./components/PiLogo";
import { Ansi } from "./components/primitives";
import { SessionPane } from "./components/SessionPane";
import { HeroBackdrop } from "./components/Transcript";
import { Sidebar } from "./components/Sidebar";
import { boot, dismissToast, newSession, openLightbox, setPane, store, toggleExpandAll, useApp } from "./state/app";

export function App() {
  useEffect(() => {
    boot();
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && !event.metaKey && key === "o") {
        event.preventDefault();
        toggleExpandAll();
      } else if (event.metaKey && key === "n") {
        event.preventDefault();
        const { active, sessions } = store.get();
        newSession((active && sessions[active]?.cwd) || window.studio.launchCwd || window.studio.homeDir);
      } else if (key === "escape" && store.get().lightbox) {
        openLightbox(undefined);
      }
    };
    // Files dropped outside a drop zone must not navigate the window to file://.
    const block = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  const session = useApp((state) => (state.active ? state.sessions[state.active] : undefined));
  const pane = useApp((state) => state.pane);
  const main = useRef<HTMLElement>(null);

  const startDrag = (event: React.PointerEvent) => {
    const element = main.current;
    if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = element.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const split = (rect.right - e.clientX) / rect.width;
      setPane({ split: Math.min(0.75, Math.max(0.25, split)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-full">
      <Sidebar />
      <main ref={main} className="flex min-w-0 flex-1 border-l border-line bg-canvas">
        <section className={`relative min-w-0 flex-1 ${pane.open && pane.full ? "hidden" : ""}`}>
          {session ? (
            <SessionPane key={session.handle} session={session} />
          ) : (
            <div className="drag relative flex h-full flex-col items-center justify-center gap-5 overflow-hidden">
              <HeroBackdrop />
              <PiLogo size={56} animate className="relative" />
              <div className="relative text-[13px] text-faint">Pick a session or start a new one (⌘N)</div>
            </div>
          )}
          <Toasts />
        </section>
        {pane.open && (
          <>
            {!pane.full && (
              <div onPointerDown={startDrag} className="w-1 shrink-0 cursor-col-resize border-l border-line hover:bg-accent/40" title="Drag to resize" />
            )}
            <section className="min-w-0 shrink-0" style={{ width: pane.full ? "100%" : `${pane.split * 100}%` }}>
              <BrowserPane />
            </section>
          </>
        )}
      </main>
      <Lightbox />
    </div>
  );
}

function Lightbox() {
  const src = useApp((state) => state.lightbox);
  if (!src) return null;
  return (
    <button type="button" onClick={() => openLightbox(undefined)} className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/75 p-10">
      <img alt="" src={src} className="max-h-full max-w-full rounded-lg shadow-2xl" />
    </button>
  );
}

function Toasts() {
  const toasts = useApp((state) => state.toasts);
  return (
    <div className="pointer-events-none absolute top-14 right-4 z-40 flex w-80 flex-col gap-2">
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
