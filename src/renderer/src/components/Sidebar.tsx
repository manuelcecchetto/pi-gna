import { ChevronRight, Folder, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import { baseName, relativeTime, tildify } from "../lib/format";
import { type Attention, attention, isDraft, strongestAttention } from "../lib/session";
import { clampSidebarWidth, SIDEBAR_DEFAULT, sidebarDrag } from "../lib/layout";
import { type ProjectRow, type ProjectView, projectViews, togglePinnedProject, usePinnedProjects } from "../lib/projects";
import { activate, newChat, newSession, openSession, sessionTitle, setSidebar, toggleSidebar, useApp } from "../state/app";
import { PI, PiLogo, PiSpinner } from "./PiLogo";
import { PignaMark } from "./PignaMark";

const SESSIONS_PER_PROJECT = 6;

export function Sidebar() {
  const projects = useApp((state) => state.projects);
  const sessions = useApp((state) => state.sessions);
  const active = useApp((state) => state.active);
  const layout = useApp((state) => state.sidebar);
  const pinned = usePinnedProjects();
  const [dragging, setDragging] = useState(false);
  const home = window.studio.homeDir;
  const activeCwd = active ? sessions[active]?.cwd : undefined;

  const groups = useMemo(() => projectViews(projects, Object.values(sessions), pinned), [projects, sessions, pinned]);
  // You are in an empty new chat: highlight "New chat" instead of a row.
  const activeSession = active ? sessions[active] : undefined;
  const inDraft = Boolean(activeSession && isDraft(activeSession));
  const width = clampSidebarWidth(layout.width, window.innerWidth);

  const openFolder = async () => {
    const folder = await window.studio.pickFolder();
    if (folder) newSession(folder);
  };

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    setDragging(true);
    const startWidth = width;
    const move = (e: PointerEvent) => {
      const target = sidebarDrag(e.clientX, window.innerWidth);
      // Pulled to the edge: collapse, keeping the width from before the drag for when it reopens.
      setSidebar(target.collapsed ? { collapsed: true, width: startWidth } : { collapsed: false, width: target.width }, false);
    };
    const up = () => {
      setDragging(false);
      setSidebar({}, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside
      className={`relative shrink-0 overflow-hidden bg-[var(--sidebar)] ${dragging && !layout.collapsed ? "" : "transition-[width] duration-200 ease-out"}`}
      style={{ width: layout.collapsed ? 0 : width }}
      inert={layout.collapsed}
    >
      {/* Fixed inner width, so collapsing slides the sidebar away instead of reflowing it. */}
      <div className="flex h-full flex-col" style={{ width }}>
        <div className="drag flex h-[52px] shrink-0 items-center pr-2.5 pl-[86px]">
          <PignaMark className="flex-1 text-[13px] font-semibold tracking-tight text-muted" />
          <IconButton title="Hide sidebar (⌘⇧S)" onClick={toggleSidebar}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>

        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={newChat}
            className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${inDraft ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
          >
            <SquarePen size={14} className="shrink-0 text-muted" />
            <span className="flex-1">New chat</span>
            <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">⌘N</span>
          </button>
        </div>

        <div className="group/projects flex items-center px-4 pt-2 pb-1">
          <span className="flex-1 text-[12.5px] font-medium text-faint">Projects</span>
          <button
            type="button"
            title="Open folder…"
            onClick={() => void openFolder()}
            className="rounded-md p-0.5 text-faint opacity-0 hover:bg-raised hover:text-fg group-hover/projects:opacity-100 focus-visible:opacity-100"
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {groups.map((group, index) => (
            <ProjectSection key={group.cwd} group={group} home={home} active={active} defaultOpen={index < 4 || group.cwd === activeCwd} />
          ))}
        </nav>
      </div>

      {!layout.collapsed && (
        <div
          onPointerDown={startResize}
          onDoubleClick={() => setSidebar({ width: SIDEBAR_DEFAULT })}
          title="Drag to resize · double-click to reset"
          className={`absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-accent/40 ${dragging ? "bg-accent/50" : ""}`}
        />
      )}
    </aside>
  );
}

/**
 * Shown in the top-left corner while the sidebar is hidden: bring it back, or start a chat. Must render after
 * <main> in the DOM: Electron applies -webkit-app-region rects in document order, so a later drag region (the
 * header under these buttons) would swallow the clicks of an earlier no-drag element.
 */
export function CollapsedSidebarControls() {
  const collapsed = useApp((state) => state.sidebar.collapsed);
  if (!collapsed) return null;
  return (
    // Traffic lights sit at x=18..77 (y center 25); start one light-gap later so the spacing reads as one row.
    <div className="no-drag fixed top-0 left-[88px] z-40 flex h-[50px] items-center gap-1">
      <IconButton title="Show sidebar (⌘⇧S)" onClick={toggleSidebar}>
        <PanelLeftOpen size={15} />
      </IconButton>
      <IconButton title="New chat (⌘N)" onClick={newChat}>
        <SquarePen size={15} />
      </IconButton>
    </div>
  );
}

/** Left padding for the leftmost header while the sidebar is hidden: the controls end at 137px. */
export const COLLAPSED_INSET = 160;

function ProjectSection({
  group,
  home,
  active,
  defaultOpen,
}: {
  group: ProjectView;
  home: string;
  active?: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? group.rows : group.rows.slice(0, SESSIONS_PER_PROJECT);
  // A collapsed project still says when one of its chats is running, waiting or unread.
  const rollup = open ? undefined : strongestAttention(group.rows.flatMap((row) => (row.live ? [row.live] : [])));
  return (
    <div className="mb-1">
      <div className="group flex items-center rounded-lg pr-1 hover:bg-raised/50">
        <button type="button" onClick={() => setOpen(!open)} title={tildify(group.cwd, home)} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left">
          <ChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          <Folder size={13} className="shrink-0 text-faint" />
          <span className="truncate text-[13px] font-medium text-fg/90">{baseName(group.cwd) || "/"}</span>
          {rollup && <Indicator level={rollup} />}
        </button>
        {/* Pinned projects keep their pin visible; hovering it offers to unpin. */}
        <button
          type="button"
          title={group.pinned ? "Unpin project" : "Pin project"}
          aria-pressed={group.pinned}
          onClick={() => togglePinnedProject(group.cwd)}
          className={`group/pin rounded-md p-1 text-faint hover:bg-raised hover:text-fg focus-visible:opacity-100 ${group.pinned ? "" : "opacity-0 group-hover:opacity-100"}`}
        >
          {group.pinned ? (
            <>
              <Pin size={12} className="group-hover/pin:hidden" />
              <PinOff size={12} className="hidden group-hover/pin:block" />
            </>
          ) : (
            <Pin size={12} />
          )}
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

function SessionRow({ row, active }: { row: ProjectRow; active: boolean }) {
  const live = row.live;
  const title = live ? sessionTitle(live) : (row.summary?.title ?? "New session");
  const level = live ? attention(live) : undefined;
  const needsYou = level === "waiting" || level === "failed" || level === "unread";
  const onClick = () => {
    if (live) activate(live.handle);
    else if (row.summary) openSession(row.summary);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-left ${active ? "bg-raised text-fg" : needsYou ? "text-fg hover:bg-raised/50" : "text-muted hover:bg-raised/50 hover:text-fg"}`}
    >
      <span className="grid w-3 shrink-0 place-items-center">{level && <Indicator level={level} />}</span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${needsYou ? "font-medium" : ""}`}>{title}</span>
      {row.time && <span className="shrink-0 font-mono text-[10.5px] text-faint">{relativeTime(row.time)}</span>}
    </button>
  );
}

/** The pi logo tells the state: spinning while working, one still logo color for what needs you. */
const MARKS: Record<Exclude<Attention, "idle" | "running">, { color: string; title: string; pulse?: boolean }> = {
  waiting: { color: PI.yellow, title: "Waiting for you", pulse: true },
  failed: { color: PI.coral, title: "Failed or exited" },
  unread: { color: PI.blue, title: "Finished, not seen yet" },
};

function Indicator({ level }: { level: Attention }) {
  if (level === "idle") return null;
  if (level === "running") return <PiSpinner size={12} />;
  const mark = MARKS[level];
  return (
    <span title={mark.title} className="grid place-items-center">
      <PiLogo size={12} color={mark.color} className={mark.pulse ? "pulse-dot" : undefined} />
    </span>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg">
      {children}
    </button>
  );
}
