import { ChevronsDownUp, ChevronsUpDown, Globe, X } from "lucide-react";
import type { SessionState } from "../lib/session";
import { formatCost, formatTokens, relativeTime, tildify } from "../lib/format";
import { closeSession, dismissRecentWrite, sessionTitle, toggleBrowser, toggleExpandAll, useApp } from "../state/app";
import { Composer } from "./Composer";
import { Ansi } from "./primitives";
import { Transcript } from "./Transcript";

export function SessionPane({ session }: { session: SessionState }) {
  const expandAll = useApp((state) => state.expandAll);
  const browserOpen = useApp((state) => state.pane.open);
  return (
    <div className="flex h-full min-w-0 flex-col">
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
  const usage = session.stats?.contextUsage;
  const percent = usage?.percent ?? undefined;
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
      {percent !== undefined && percent !== null && (
        <span className="flex items-center gap-1.5" title={`${formatTokens(usage?.tokens ?? 0)} / ${formatTokens(usage?.contextWindow ?? 0)} tokens in context`}>
          <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
            <span className={`block h-full ${percent > 80 ? "bg-warn" : "bg-muted"}`} style={{ width: `${Math.min(100, percent)}%` }} />
          </span>
          {Math.round(percent)}%
        </span>
      )}
      {session.stats && session.stats.cost > 0 && <span>{formatCost(session.stats.cost)}</span>}
    </footer>
  );
}
