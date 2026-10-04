import { useEffect, useRef, useState } from "react";
import { AtpPage } from "./components/Atp";
import { BrowserPane } from "./components/BrowserPane";
import { ComputerPage } from "./components/Computer";
import { GithubPage } from "./components/GitHub";
import { KanbanPage } from "./components/Kanban";
import { LamentsPage } from "./components/Laments";
import { Ansi } from "./components/primitives";
import { SessionPane } from "./components/SessionPane";
import { HeroBackdrop } from "./components/Transcript";
import { CollapsedSidebarControls, Sidebar } from "./components/Sidebar";
import { UpdateDialog } from "./components/Update";
import { boot, dismissToast, newChat, openLightbox, setPane, store, toggleExpandAll, useApp } from "./state/app";

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
        newChat();
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
  const page = useApp((state) => state.page);
  const pane = useApp((state) => state.pane);
  const collapsed = useApp((state) => state.sidebar.collapsed);
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
      <main ref={main} className={`flex min-w-0 flex-1 bg-canvas ${collapsed ? "" : "border-l border-line"}`}>
        <section className={`relative min-w-0 flex-1 ${pane.open && pane.full ? "hidden" : ""}`}>
          {page?.kind === "computer" ? (
            <ComputerPage />
          ) : page?.kind === "laments" ? (
            <LamentsPage key={page.cwd} page={page} />
          ) : page?.kind === "github" ? (
            <GithubPage key={page.cwd} page={page} />
          ) : page?.kind === "atp" ? (
            <AtpPage key={page.cwd} page={page} />
          ) : page ? (
            <KanbanPage page={page} />
          ) : session ? (
            <SessionPane key={session.handle} session={session} />
          ) : (
            <div className="drag relative flex h-full flex-col items-center justify-end overflow-hidden pb-[16vh]">
              <HeroBackdrop />
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
      <CollapsedSidebarControls />
      <Lightbox />
      <UpdateDialog />
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

/** The window reloaded into a build newer than main (StudioApi.stale); stays until pi-gna restarts. */
function RebuiltNotice() {
  // Mains from before the relaunch handler cannot restart themselves.
  const [manual, setManual] = useState(false);
  return (
    <div className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line-strong bg-panel px-3 py-2.5 text-[12.5px] text-fg shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
      <div className="min-w-0">
        <p>pi-gna was rebuilt after it started. This window has the new build but the app behind it does not, so new features fail until you restart.</p>
        {manual ? (
          <p className="mt-1.5 text-muted">Quit pi-gna (⌘Q) and start it again.</p>
        ) : (
          <button
            type="button"
            onClick={() => void window.studio.relaunch().catch(() => setManual(true))}
            className="mt-2 rounded-lg border border-line-strong px-2.5 py-1 text-[12px] hover:bg-raised"
          >
            Restart pi-gna (running chats stop)
          </button>
        )}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((state) => state.toasts);
  return (
    <div className="pointer-events-none absolute top-14 right-4 z-40 flex w-80 flex-col gap-2">
      {window.studio.stale && <RebuiltNotice />}
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
