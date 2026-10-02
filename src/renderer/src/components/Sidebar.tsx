import { ChevronRight, Folder, FolderPlus, Plus, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectGroup, SessionSummary } from "../../../shared/ipc";
import { baseName, relativeTime, tildify } from "../lib/format";
import type { SessionState } from "../lib/session";
import { activate, newSession, openSession, sessionTitle, useApp } from "../state/app";
import { PiLogo } from "./PiLogo";

const SESSIONS_PER_PROJECT = 6;

interface Row {
  key: string;
  title: string;
  time?: number;
  summary?: SessionSummary;
  live?: SessionState;
}

export function Sidebar() {
  const projects = useApp((state) => state.projects);
  const sessions = useApp((state) => state.sessions);
  const active = useApp((state) => state.active);
  const home = window.studio.homeDir;
  const activeCwd = active ? sessions[active]?.cwd : undefined;

  const groups = useMemo(() => mergeOpenSessions(projects, Object.values(sessions)), [projects, sessions]);

  const openFolder = async () => {
    const folder = await window.studio.pickFolder();
    if (folder) newSession(folder);
  };

  return (
    <aside className="flex w-[268px] shrink-0 flex-col bg-[var(--sidebar)]">
      <div className="drag flex h-[52px] shrink-0 items-center gap-0.5 pr-2.5 pl-[86px]">
        <PiLogo size={14} />
        <span className="ml-2 flex-1 text-[12.5px] font-medium tracking-tight text-muted">studio</span>
        <IconButton title="Open folder…" onClick={() => void openFolder()}>
          <FolderPlus size={15} />
        </IconButton>
        <IconButton title="New session (⌘N)" onClick={() => newSession(activeCwd ?? window.studio.launchCwd ?? home)}>
          <SquarePen size={15} />
        </IconButton>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {groups.map((group, index) => (
          <ProjectSection key={group.cwd} group={group} home={home} active={active} defaultOpen={index < 4 || group.cwd === activeCwd} />
        ))}
      </nav>
    </aside>
  );
}

function mergeOpenSessions(projects: ProjectGroup[], open: SessionState[]): { cwd: string; rows: Row[] }[] {
  const byCwd = new Map<string, Row[]>();
  for (const project of projects) {
    byCwd.set(
      project.cwd,
      project.sessions.map((summary) => ({ key: summary.path, title: summary.title, time: summary.modifiedAt, summary })),
    );
  }
  for (const session of open) {
    const rows = byCwd.get(session.cwd) ?? [];
    const existing = rows.find((row) => row.summary && row.summary.path === session.sessionPath);
    if (existing) existing.live = session;
    else rows.unshift({ key: session.handle, title: sessionTitle(session), live: session });
    byCwd.set(session.cwd, rows);
  }
  const groups = [...byCwd.entries()].map(([cwd, rows]) => ({ cwd, rows }));
  // Projects with open sessions first, then by recency (projects arrive sorted).
  return groups.sort((a, b) => Number(b.rows.some((r) => r.live)) - Number(a.rows.some((r) => r.live)));
}

function ProjectSection({
  group,
  home,
  active,
  defaultOpen,
}: {
  group: { cwd: string; rows: Row[] };
  home: string;
  active?: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? group.rows : group.rows.slice(0, SESSIONS_PER_PROJECT);
  return (
    <div className="mb-1">
      <div className="group flex items-center rounded-lg pr-1 hover:bg-raised/50">
        <button type="button" onClick={() => setOpen(!open)} title={tildify(group.cwd, home)} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left">
          <ChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          <Folder size={13} className="shrink-0 text-faint" />
          <span className="truncate text-[13px] font-medium text-fg/90">{baseName(group.cwd) || "/"}</span>
        </button>
        <button
          type="button"
          title="New session here"
          onClick={() => newSession(group.cwd)}
          className="rounded-md p-1 text-faint opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100"
        >
          <Plus size={13} />
        </button>
      </div>
      {open && (
        <div className="ml-3 flex flex-col">
          {rows.map((row) => (
            <SessionRow key={row.key} row={row} active={row.live?.handle === active && active !== undefined} />
          ))}
          {group.rows.length > SESSIONS_PER_PROJECT && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="px-3 py-1 text-left text-[12px] text-faint hover:text-muted">
              {showAll ? "Show less" : `Show ${group.rows.length - SESSIONS_PER_PROJECT} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SessionRow({ row, active }: { row: Row; active: boolean }) {
  const live = row.live;
  const title = live ? sessionTitle(live) : row.title;
  const onClick = () => {
    if (live) activate(live.handle);
    else if (row.summary) openSession(row.summary);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-left ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised/50 hover:text-fg"}`}
    >
      <span className="grid w-2 shrink-0 place-items-center">
        {live && (
          <span
            className={`h-1.5 w-1.5 rounded-full ${live.dialogs.length ? "bg-warn pulse-dot" : live.running ? "bg-accent pulse-dot" : live.phase === "exited" ? "bg-bad" : "bg-ok/80"}`}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      {row.time && <span className="shrink-0 font-mono text-[10.5px] text-faint">{relativeTime(row.time)}</span>}
    </button>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg">
      {children}
    </button>
  );
}
