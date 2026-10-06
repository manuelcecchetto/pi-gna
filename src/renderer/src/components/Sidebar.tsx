import { Angry, Copy, Folder, FolderOpen, GitPullRequest, MessagesSquare, Network, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, Settings, SquareKanban, SquarePen, X } from "./icons";
import { useMemo, useRef, useState } from "react";
import { cardOfChat, projectOf } from "../../../shared/board";
import { projectLaments, SEVERITY } from "../../../shared/laments";
import type { Feature } from "../../../shared/settings";
import { baseName, relativeTime, tildify } from "../lib/format";
import { type Attention, attention, isDraft, strongestAttention } from "../../../shared/session-state";
import { worstSeverity } from "../lib/laments";
import { clampSidebarWidth, SIDEBAR_DEFAULT, sidebarDrag } from "../lib/layout";
import { type ProjectRow, type ProjectView, projectViews, togglePinnedProject, usePinnedProjects } from "../lib/projects";
import {
  activate,
  addChatToBoard,
  closeSession,
  newChat,
  newSession,
  openSession,
  openSettings,
  sessionTitle,
  setSidebar,
  showBoard,
  showPage,
  store,
  toggleSidebar,
  useApp,
} from "../state/app";
import { useAtp } from "../state/atp";
import { type MenuItem, useContextMenu } from "./ContextMenu";
import { PI, PiLogo, PiSpinner } from "./PiLogo";
import { PignaMark } from "./PignaMark";
import { DigitHint, useCommandDigits } from "./primitives";
import { SettingsNav } from "./Settings";
import { useThemeImage } from "./ThemeRoot";
import { UpdateRow } from "./Update";

const SESSIONS_PER_PROJECT = 6;
/** How many more chats each "Show more" reveals in a project. */
const SESSIONS_PAGE = 10;

export function Sidebar() {
  const projects = useApp((state) => state.projects);
  const sessions = useApp((state) => state.sessions);
  // A page (the board, the laments, GitHub) covers the active chat: no chat row is highlighted then.
  const page = useApp((state) => state.page);
  // The project a page row opens: the open page's, else the active chat's.
  const pageCwd = useApp((state) => {
    const chat = state.active && state.sessions[state.active]?.cwd;
    return state.page?.cwd ?? (chat ? projectOf(chat) : undefined);
  });
  const laments = useApp((state) => state.laments);
  const openLaments = useMemo(() => (pageCwd ? projectLaments(laments, pageCwd) : []), [laments, pageCwd]);
  const worst = worstSeverity(openLaments);
  const runningPlans = useAtp((state) => Object.keys(state.runners).length);
  const features = useApp((state) => state.settings.features);
  const active = useApp((state) => (state.page ? undefined : state.active));
  const layout = useApp((state) => state.sidebar);
  const pinned = usePinnedProjects();
  const [dragging, setDragging] = useState(false);
  const { open: openMenu, menu } = useContextMenu();
  const home = window.studio.homeDir;
  const activeChat = active ? sessions[active]?.cwd : undefined;
  const activeCwd = activeChat && projectOf(activeChat);

  const groups = useMemo(() => projectViews(projects, Object.values(sessions), pinned), [projects, sessions, pinned]);
  // You are in an empty new chat: highlight "New chat" instead of a row.
  const activeSession = active ? sessions[active] : undefined;
  const inDraft = Boolean(activeSession && isDraft(activeSession));
  const width = clampSidebarWidth(layout.width, window.innerWidth);

  // Which projects are open and how many of their chats they show, here rather than in each section: ⌘1…⌘9 number the chat rows
  // you can see. A project opens as it was when it first showed: the first four, and the active chat's.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  const firstOpen = useRef(new Map<string, boolean>());
  groups.forEach((group, index) => {
    if (!firstOpen.current.has(group.cwd)) firstOpen.current.set(group.cwd, index < 4 || group.cwd === activeCwd);
  });
  const isOpen = (cwd: string) => opened[cwd] ?? firstOpen.current.get(cwd) ?? false;
  const visible = groups.flatMap((group) => (isOpen(group.cwd) ? group.rows.slice(0, shown[group.cwd] ?? SESSIONS_PER_PROJECT) : []));
  const numbered = visible.slice(0, 9);
  const settingsMode = page?.kind === "settings";
  const hints = useCommandDigits(numbered.map((row) => () => openRow(row)), !settingsMode);
  const digits = new Map(numbered.map((row, index) => [row.key, index + 1]));

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
        <div className="drag titlebar flex shrink-0 items-center pr-2.5 pl-[calc(86px*var(--unzoom))]">
          <span className="flex flex-1 items-baseline gap-1.5">
            <PignaMark className="text-[13px] font-semibold tracking-tight text-muted" />
            <span className="font-mono text-[10.5px] text-faint">{window.studio.version}</span>
          </span>
          <IconButton title="Hide sidebar (⌘⇧S)" onClick={toggleSidebar}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>

        {settingsMode ? (
          <SettingsNav current={page.section} />
        ) : (
          <>
            <div className="px-2 pb-2">
              <button
                type="button"
                onClick={newChat}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${inDraft ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
              >
                <SquarePen size={16} className="shrink-0 text-muted" />
                <span className="flex-1">New chat</span>
                <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">⌘N</span>
              </button>
              {features.kanban && (
                <button
                  type="button"
                  onClick={() => page?.kind !== "kanban" && showPage("kanban", page?.cwd)}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${page?.kind === "kanban" ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
                >
                  <SquareKanban size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">Kanban</span>
                  <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">⌘⇧K</span>
                </button>
              )}
              {features.laments && (
                <button
                  type="button"
                  onClick={() => page?.kind !== "laments" && showPage("laments", page?.cwd)}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${page?.kind === "laments" ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
                >
                  <Angry size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">Laments</span>
                  {worst && (
                    <span className="flex items-center gap-1 group-hover:hidden" title={`${openLaments.length} open, the worst ${SEVERITY[worst].label.toLowerCase()}`}>
                      <span className="text-[12px] leading-none">{SEVERITY[worst].emoji}</span>
                      <span className="font-mono text-[11px] text-faint">{openLaments.length}</span>
                    </span>
                  )}
                  <span className={`font-mono text-[11px] text-faint ${worst ? "hidden group-hover:inline" : "opacity-0 group-hover:opacity-100"}`}>⌘⇧L</span>
                </button>
              )}
              {features.github && (
                <button
                  type="button"
                  onClick={() => page?.kind !== "github" && showPage("github", page?.cwd)}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${page?.kind === "github" ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
                >
                  <GitPullRequest size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">GitHub</span>
                  <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">⌘⇧G</span>
                </button>
              )}
              {features.atp && (
                <button
                  type="button"
                  onClick={() => page?.kind !== "atp" && showPage("atp", page?.cwd)}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${page?.kind === "atp" ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
                >
                  <Network size={16} className="shrink-0 text-muted" />
                  <span className="flex-1">ATP</span>
                  {runningPlans > 0 && (
                    <span className="flex items-center gap-1 group-hover:hidden" title={`${runningPlans} plan${runningPlans === 1 ? "" : "s"} running`}>
                      <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="font-mono text-[11px] text-faint">{runningPlans}</span>
                    </span>
                  )}
                  <span className={`font-mono text-[11px] text-faint ${runningPlans > 0 ? "hidden group-hover:inline" : "opacity-0 group-hover:opacity-100"}`}>⌘⇧A</span>
                </button>
              )}
            </div>

            <div className="group/projects flex items-center px-4 pt-2 pb-1">
              <span className="flex-1 text-[13.5px] font-medium text-faint">Projects</span>
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
              {groups.map((group) => (
                <ProjectSection
                  key={group.cwd}
                  group={group}
                  home={home}
                  active={active}
                  features={features}
                  open={isOpen(group.cwd)}
                  onOpen={(open) => setOpened((all) => ({ ...all, [group.cwd]: open }))}
                  shown={shown[group.cwd] ?? SESSIONS_PER_PROJECT}
                  onShown={(count) => setShown((all) => ({ ...all, [group.cwd]: count }))}
                  digits={hints ? digits : undefined}
                  onMenu={openMenu}
                />
              ))}
            </nav>
            <UpdateRow />
            <div className="shrink-0 px-2 py-2">
              <button type="button" onClick={() => openSettings()} className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] text-fg/90 hover:bg-raised/60">
                <Settings size={16} className="shrink-0 text-muted" />
                <span className="flex-1">Settings</span>
                <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">⌘,</span>
              </button>
            </div>
          </>
        )}
      </div>

      {!layout.collapsed && (
        <div
          onPointerDown={startResize}
          onDoubleClick={() => setSidebar({ width: SIDEBAR_DEFAULT })}
          title="Drag to resize · double-click to reset"
          className={`absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-accent/40 ${dragging ? "bg-accent/50" : ""}`}
        />
      )}
      {menu}
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
    // Traffic lights sit at x=18..77 (y center 25) in screen px at every zoom; start one light-gap later so the spacing
    // reads as one row.
    <div className="no-drag fixed top-0 left-[calc(88px*var(--unzoom))] z-40 flex min-h-[calc(50px*var(--unzoom))] items-center gap-1">
      <IconButton title="Show sidebar (⌘⇧S)" onClick={toggleSidebar}>
        <PanelLeftOpen size={15} />
      </IconButton>
      <IconButton title="New chat (⌘N)" onClick={newChat}>
        <SquarePen size={15} />
      </IconButton>
    </div>
  );
}

/**
 * Left padding for the leftmost header while the sidebar is hidden: the controls start at 88 screen px and are 49px
 * wide (they zoom), so they end at 137px at Actual Size.
 */
export const COLLAPSED_INSET = "calc(88px * var(--unzoom) + 72px)";

function ProjectSection({
  group,
  home,
  active,
  features,
  open,
  onOpen,
  shown,
  onShown,
  digits,
  onMenu,
}: {
  group: ProjectView;
  home: string;
  active?: string;
  features: Record<Feature, boolean>;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** How many of the project's chats are listed. */
  shown: number;
  onShown: (count: number) => void;
  /** ⌘1…⌘9 of the rows that have one, while ⌘ is held. */
  digits?: Map<string, number>;
  onMenu: OpenMenu;
}) {
  const rows = group.rows.slice(0, shown);
  const logo = useThemeImage(useApp((state) => state.themes), group.cwd, "logo");
  // A collapsed project still says when one of its chats is running, waiting or unread.
  const rollup = open ? undefined : strongestAttention(group.rows.flatMap((row) => (row.live ? [row.live] : [])));
  return (
    <div className="mb-1">
      <div className="group flex items-center rounded-lg pr-1 hover:bg-raised/50" onContextMenu={(event) => onMenu(event, projectMenu(group, features))}>
        <button type="button" onClick={() => onOpen(!open)} title={tildify(group.cwd, home)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left">
          {/* The folder is the disclosure mark: open while the project's chats show. */}
          {logo ? <img src={logo} alt="" className="size-4 shrink-0 object-contain" /> : open ? <FolderOpen size={16} className="shrink-0 text-muted" /> : <Folder size={16} className="shrink-0 text-muted" />}
          <span className="truncate text-[14px] font-medium text-fg/90">{baseName(group.cwd) || "/"}</span>
          {rollup && <Indicator level={rollup} />}
        </button>
        {features.kanban && (
          <button
            type="button"
            title="Kanban board"
            onClick={() => showBoard(group.cwd)}
            className="rounded-md p-1 text-faint opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100"
          >
            <SquareKanban size={12} />
          </button>
        )}
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
        <div className="flex flex-col">
          {rows.map((row) => (
            <SessionRow key={row.key} row={row} active={row.live?.handle === active && active !== undefined} kanban={features.kanban} digit={digits?.get(row.key)} onMenu={onMenu} />
          ))}
          {/* Long histories page in a few chats at a time; "Show less" sits beside "Show more", never past the whole list. Both line up with the chat titles. */}
          {group.rows.length > SESSIONS_PER_PROJECT && (
            <div className="flex pl-[23px]">
              {rows.length < group.rows.length && (
                <button type="button" onClick={() => onShown(shown + SESSIONS_PAGE)} className="px-3 py-1 text-left text-[13px] text-faint hover:text-muted">
                  Show more
                </button>
              )}
              {shown > SESSIONS_PER_PROJECT && (
                <button type="button" onClick={() => onShown(SESSIONS_PER_PROJECT)} className="px-3 py-1 text-left text-[13px] text-faint hover:text-muted">
                  Show less
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type OpenMenu = (event: React.MouseEvent, sections: MenuItem[][]) => void;

function projectMenu(group: ProjectView, features: Record<Feature, boolean>): MenuItem[][] {
  return [
    [
      { label: "New chat here", icon: <SquarePen size={13} />, onSelect: () => newSession(group.cwd) },
      ...(features.kanban ? [{ label: "Kanban board", icon: <SquareKanban size={13} />, onSelect: () => showBoard(group.cwd) }] : []),
      ...(features.laments ? [{ label: "Laments", icon: <Angry size={13} />, onSelect: () => showPage("laments", group.cwd) }] : []),
      ...(features.github ? [{ label: "GitHub issues and PRs", icon: <GitPullRequest size={13} />, onSelect: () => showPage("github", group.cwd) }] : []),
    ],
    [
      group.pinned
        ? { label: "Unpin project", icon: <PinOff size={13} />, onSelect: () => togglePinnedProject(group.cwd) }
        : { label: "Pin project", icon: <Pin size={13} />, onSelect: () => togglePinnedProject(group.cwd) },
      { label: "Copy path", icon: <Copy size={13} />, onSelect: () => void navigator.clipboard.writeText(group.cwd) },
    ],
  ];
}

function sessionMenu(row: ProjectRow, open: () => void, active: boolean, kanban: boolean): MenuItem[][] {
  const live = row.live;
  const path = live?.sessionPath ?? row.summary?.path;
  const card = path ? cardOfChat(store.get().board, path) : undefined;
  // As the chat header's card chip: an exited chat or an empty draft has nothing to put on the board.
  const addable = live && !card && live.sessionPath && !isDraft(live) && live.phase !== "exited" ? live : undefined;
  return [
    active ? [] : [{ label: "Open", icon: <MessagesSquare size={13} />, onSelect: open }],
    !kanban
      ? []
      : card
        ? [{ label: "Show on the board", icon: <SquareKanban size={13} />, hint: card.title, onSelect: () => showBoard(card.cwd, card.id) }]
        : addable
          ? [{ label: "Add to the Kanban board", icon: <SquareKanban size={13} />, onSelect: () => void addChatToBoard(addable.handle) }]
          : [],
    live ? [{ label: "Close chat", icon: <X size={13} />, hint: "Stops its pi process", onSelect: () => void closeSession(live.handle) }] : [],
  ];
}

/** Open a sidebar row's chat: switch to it while it runs, else load it from its session file. */
function openRow(row: ProjectRow): void {
  if (row.live) activate(row.live.handle);
  else if (row.summary) openSession(row.summary);
}

function SessionRow({ row, active, kanban, digit, onMenu }: { row: ProjectRow; active: boolean; kanban: boolean; digit?: number; onMenu: OpenMenu }) {
  const live = row.live;
  const title = live ? sessionTitle(live) : (row.summary?.title ?? "New session");
  const level = live ? attention(live) : undefined;
  const needsYou = level === "waiting" || level === "failed" || level === "unread";
  const onClick = () => openRow(row);
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(event) => onMenu(event, sessionMenu(row, onClick, active, kanban))}
      className={`group flex items-center gap-2.5 rounded-lg py-[5px] pr-2.5 pl-3 text-left ${active ? "bg-raised text-fg" : needsYou ? "text-fg hover:bg-raised/50" : "text-muted hover:bg-raised/50 hover:text-fg"}`}
    >
      <span className="grid w-4 shrink-0 place-items-center">{level && <Indicator level={level} />}</span>
      <span className={`min-w-0 flex-1 truncate text-[14px] ${needsYou ? "font-medium" : ""}`}>{title}</span>
      {digit !== undefined ? <DigitHint digit={digit} /> : row.time && <span className="shrink-0 font-mono text-[10.5px] text-faint">{relativeTime(row.time)}</span>}
    </button>
  );
}

/** The pi logo tells the state: spinning while working, one still logo color for what needs you. */
const MARKS: Record<Exclude<Attention, "idle" | "running">, { color: string; title: string; pulse?: boolean }> = {
  waiting: { color: PI.yellow, title: "Waiting for you", pulse: true },
  failed: { color: PI.coral, title: "Failed or exited" },
  unread: { color: PI.blue, title: "Finished, not seen yet" },
};

export function Indicator({ level }: { level: Attention }) {
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
