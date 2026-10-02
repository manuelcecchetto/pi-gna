import { ChevronsDownUp, ChevronsUpDown, Globe, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import type { SessionState } from "../lib/session";
import { relativeTime, tildify } from "../lib/format";
import { attachFiles, closeSession, dismissRecentWrite, sessionTitle, toggleBrowser, toggleExpandAll, useApp } from "../state/app";
import { Composer } from "./Composer";
import { Ansi } from "./primitives";
import { Transcript } from "./Transcript";

export function SessionPane({ session }: { session: SessionState }) {
  const expandAll = useApp((state) => state.expandAll);
  const browserOpen = useApp((state) => state.pane.open);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  const canDrop = session.phase !== "exited";
  return (
    <div
      className="relative flex h-full min-w-0 flex-col"
      onDragEnter={(event) => {
        if (!hasFiles(event) || !canDrop) return;
        depth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event) || !canDrop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (canDrop) void attachFiles(session.handle, [...event.dataTransfer.files]);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-accent/60 bg-canvas/85">
          <div className="flex flex-col items-center gap-2 text-[13.5px] text-fg">
            <Paperclip size={20} className="text-accent" />
            Drop files or folders to attach
            <span className="text-[12px] text-faint">Images are shown to the model; files are passed by path</span>
          </div>
        </div>
      )}
      <header className="drag dashed-b flex h-[52px] shrink-0 items-center gap-3 px-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-fg">{sessionTitle(session)}</div>
        </div>
        <button
          type="button"
          onClick={toggleBrowser}
          title={browserOpen ? "Hide browser (⌘B)" : "Show browser (⌘B)"}
          className={`rounded-md p-1.5 hover:bg-raised hover:text-fg ${browserOpen ? "text-accent" : "text-faint"}`}
        >
          <Globe size={15} />
        </button>
        <button
          type="button"
          onClick={toggleExpandAll}
          title={expandAll ? "Collapse all (Ctrl+O)" : "Expand all (Ctrl+O)"}
          className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg"
        >
          {expandAll ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
        </button>
        <button type="button" onClick={() => void closeSession(session.handle)} title="Close session (stops its pi process)" className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg">
          <X size={15} />
        </button>
      </header>
      {session.phase === "exited" && <ExitBanner session={session} />}
      {session.recentWriteAt && !session.prompted && session.phase !== "exited" && (
        <div className="flex items-center gap-3 border-b border-warn/30 bg-warn/5 px-5 py-2 text-[12.5px] text-muted">
          <span>
            <span className="text-warn">Updated {relativeTime(session.recentWriteAt) === "now" ? "just now" : `${relativeTime(session.recentWriteAt)} ago`}.</span> If this session is still open in another pi, prompting
            here makes two writers append to the same file.
          </span>
          <button type="button" onClick={() => dismissRecentWrite(session.handle)} className="ml-auto shrink-0 text-faint hover:text-fg">
            <X size={13} />
          </button>
        </div>
      )}
      <Transcript session={session} />
      <Composer session={session} />
      <StatusBar session={session} />
    </div>
  );
}

function ExitBanner({ session }: { session: SessionState }) {
  const exit = session.exit;
  return (
    <div className="border-b border-bad/30 bg-bad/5 px-5 py-2 text-[12.5px]">
      <span className="text-bad">pi exited</span>
      <span className="text-muted"> ({exit?.error ?? exit?.signal ?? `code ${exit?.code}`}). The transcript is read-only; reopen the session from the sidebar.</span>
      {exit?.stderrTail && <pre className="selectable mt-1.5 max-h-28 overflow-auto font-mono text-[11px] text-faint">{exit.stderrTail.trim().split("\n").slice(-8).join("\n")}</pre>}
    </div>
  );
}

function StatusBar({ session }: { session: SessionState }) {
  const home = window.studio.homeDir;
  const statuses = Object.entries(session.statuses);
  const phaseDot = session.phase === "starting" ? "bg-warn pulse-dot" : session.phase === "exited" ? "bg-bad" : "bg-ok";
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 overflow-hidden px-5 font-mono text-[11px] text-faint">
      <span className="flex items-center gap-1.5" title={`pi ${session.phase}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${phaseDot}`} />
        {session.phase === "starting" ? "starting pi…" : tildify(session.cwd, home)}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
        {statuses.map(([key, text]) => (
          <span key={key} className="truncate" title={key}>
            <Ansi text={text} />
          </span>
        ))}
      </span>
    </footer>
  );
}
