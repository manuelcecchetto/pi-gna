// A newer pi-gna release: the row at the foot of the sidebar, and the dialog it opens with the release notes
// and the install. Main's Updater does the work (docs/DESIGN.md, Updates); these only show its state.
import { ArrowUpCircle, ChevronRight, X } from "./icons";
import { useEffect, useRef } from "react";
import type { UpdateState } from "../../../shared/ipc";
import { setOverlay, showUpdate, useApp } from "../state/app";
import { Markdown } from "./Markdown";

type Pending = Exclude<UpdateState, { phase: "idle" }>;

function summary(update: Pending): string {
  const { version } = update.release;
  if (update.phase === "available") return `pi-gna ${version} is available`;
  if (update.phase === "downloading") return update.progress < 1 ? `Downloading ${version}… ${Math.round(update.progress * 100)}%` : `Checking ${version}…`;
  if (update.phase === "ready") return `Restart to update to ${version}`;
  return `Updating to ${version} failed`;
}

/** Foot of the sidebar while there is a newer release; opens the dialog. */
export function UpdateRow() {
  const update = useApp((state) => state.update);
  if (update.phase === "idle") return null;
  const failed = update.phase === "failed";
  return (
    <div className="shrink-0 border-t border-line px-2 py-2">
      <button
        type="button"
        onClick={() => showUpdate(true)}
        className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-raised/60 ${failed ? "text-warn" : "text-fg/90"}`}
      >
        <ArrowUpCircle size={14} className={`shrink-0 ${failed ? "" : "text-accent"}`} />
        <span className="min-w-0 flex-1 truncate">{summary(update)}</span>
        <ChevronRight size={13} className="shrink-0 text-faint group-hover:text-muted" />
      </button>
      {update.phase === "downloading" && <Progress value={update.progress} className="mx-2.5 mt-1" />}
    </div>
  );
}

function Progress({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1 overflow-hidden rounded-full bg-raised ${className}`}>
      <div className={`h-full rounded-full bg-accent transition-[width] duration-300 ${value >= 1 ? "animate-pulse" : ""}`} style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

export function UpdateDialog() {
  const open = useApp((state) => state.updateOpen);
  const update = useApp((state) => state.update);
  return open && update.phase !== "idle" ? <UpdateDialogBody update={update} /> : null;
}

function UpdateDialogBody({ update }: { update: Pending }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useApp((state) => Object.values(state.sessions).filter((session) => session.running || session.compacting).length);
  const { release } = update;
  const released = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

  useEffect(() => {
    dialog.current?.showModal();
    setOverlay(true); // the native browser view would draw over the dialog
    return () => setOverlay(false);
  }, []);

  const close = () => dialog.current?.close();
  const download = () => void window.studio.update.download();
  const openPage = () => window.studio.openExternal(release.url);

  return (
    <dialog
      ref={dialog}
      onClose={() => showUpdate(false)}
      onClick={(event) => {
        if (event.target === dialog.current) close(); // the backdrop
      }}
      className="card-dialog m-auto max-h-[min(640px,calc(100vh-64px))] w-[min(560px,calc(100vw-48px))] overflow-hidden rounded-2xl border border-line-strong bg-panel p-0 text-fg shadow-[0_24px_80px_-24px_rgb(0_0_0/0.6)] backdrop:bg-black/45"
    >
      <div className="flex max-h-[inherit] flex-col">
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <ArrowUpCircle size={18} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-medium">pi-gna {release.version}</h2>
            <p className="mt-0.5 text-[12px] text-faint">
              You have {window.studio.version}
              {released && ` · released ${released}`} ·{" "}
              <button type="button" onClick={openPage} className="hover:text-muted hover:underline">
                Release page
              </button>
            </p>
          </div>
          <button type="button" title="Close (Esc)" onClick={close} className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto border-y border-line px-5 py-3 text-[13px]">
          {release.notes.trim() ? <Markdown text={release.notes} /> : <p className="text-faint">This release has no notes.</p>}
        </div>

        <footer className="flex items-center gap-3 px-5 py-3">
          <div className="min-w-0 flex-1 text-[12px] leading-snug">
            {update.phase === "available" && update.manual && <p className="text-muted">{update.manual}</p>}
            {update.phase === "downloading" && (
              <>
                <p className="mb-1.5 text-muted">{update.progress < 1 ? `Downloading… ${Math.round(update.progress * 100)}%` : "Checking the download…"}</p>
                <Progress value={update.progress} />
              </>
            )}
            {update.phase === "ready" && (
              <p className="text-muted">
                Installs when you quit pi-gna.
                {running > 0 && ` Restarting now stops ${running === 1 ? "the running chat" : `${running} running chats`}.`}
              </p>
            )}
            {update.phase === "failed" && <p className="selectable text-warn">{update.error}</p>}
          </div>
          <SecondaryButton onClick={close}>{update.phase === "downloading" ? "Hide" : "Later"}</SecondaryButton>
          {update.phase === "available" &&
            (update.manual ? <PrimaryButton onClick={openPage}>Open download page</PrimaryButton> : <PrimaryButton onClick={download}>Update</PrimaryButton>)}
          {update.phase === "ready" && <PrimaryButton onClick={() => void window.studio.relaunch()}>Restart now</PrimaryButton>}
          {update.phase === "failed" && <PrimaryButton onClick={download}>Try again</PrimaryButton>}
        </footer>
      </div>
    </dialog>
  );
}

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90">
      {children}
    </button>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] text-fg hover:bg-raised">
      {children}
    </button>
  );
}
