import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { COLUMN_LABELS, projectOf } from "../../../shared/board";
import { baseName, relativeTime, tildify } from "../lib/format";
import { matchRanges, type PaletteItem, rankPalette } from "../lib/palette";
import { openFileDialog } from "../lib/preview";
import { projectViews, togglePinnedProject, usePinnedProjects } from "../lib/projects";
import {
  activate,
  addChatToBoard,
  closeSession,
  newChat,
  newSession,
  openSession,
  openSettings,
  setOverlay,
  showBoard,
  showPage,
  togglePalette,
  toggleBrowser,
  toggleExpandAll,
  toggleSidebar,
  useApp,
  useOpenChats,
} from "../state/app";
import { showFileFinder } from "../lib/file-finder";
import {
  Angry,
  AppWindow,
  Files,
  FolderOpen,
  GitPullRequest,
  type IconComponent,
  ListChevronsUpDown,
  MessageSquare,
  MousePointerClick,
  Network,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings,
  SquareKanban,
  SquarePen,
  X,
} from "./icons";
import { SECTIONS } from "./SettingsNav";

interface Entry extends PaletteItem {
  icon: IconComponent;
  /** Shortcut that does the same, shown on the right. */
  keys?: string;
  /** Shown on the right in place of keys: a chat's age, "Open" for the chat on screen. */
  aside?: string;
}

/** ⌘K: one search over every chat, the board's cards, the pages, the settings sections, the projects and app commands. */
export function CommandPalette() {
  const open = useApp((state) => state.palette);
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const entries = useEntries();
  // Ranking every chat and card can take longer than a keystroke: the field paints first, the list follows.
  const search = useDeferredValue(query);
  const sections = useMemo(() => rankPalette(entries, search), [entries, search]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  useEffect(() => {
    dialog.current?.showModal();
    setOverlay(true); // the native browser view would draw over the dialog
    return () => setOverlay(false);
  }, []);
  useEffect(() => setSelected(0), [search]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pick = (entry: Entry | undefined) => {
    if (!entry) return;
    togglePalette(false);
    entry.run();
  };
  const step = (delta: number) => setSelected((index) => (flat.length ? (index + delta + flat.length) % flat.length : 0));

  let index = 0;
  return (
    <dialog
      ref={dialog}
      aria-label="Search"
      onClose={() => togglePalette(false)}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current.close(); // the backdrop
      }}
      className="card-dialog mx-auto mt-[12vh] mb-auto max-h-[min(560px,76vh)] w-[min(640px,calc(100vw-48px))] overflow-hidden rounded-2xl border border-line-strong bg-panel p-0 text-fg shadow-[0_24px_80px_-24px_rgb(0_0_0/0.6)] backdrop:bg-black/35"
    >
      <div className="flex max-h-[inherit] flex-col">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            spellCheck={false}
            placeholder="Search chats, cards, pages, settings and commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const ctrl = event.ctrlKey && !event.metaKey;
              if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
                event.preventDefault();
                step(1);
              } else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
                event.preventDefault();
                step(-1);
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                pick(flat[selected]);
              } else if (event.key === "Escape" && query) {
                event.preventDefault(); // clears the search instead of closing
                setQuery("");
              }
            }}
            className="selectable h-12 min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={list} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {flat.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-faint">Nothing matches “{search.trim()}”.</div>}
          {sections.map((section) => (
            <div key={section.group} className="pb-1">
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">{section.group}</div>
              {section.items.map((entry) => {
                const at = index++;
                const Icon = entry.icon;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={at === selected}
                    data-index={at}
                    onClick={() => pick(entry)}
                    onMouseMove={() => setSelected(at)}
                    className={`flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left ${at === selected ? "bg-raised" : ""}`}
                  >
                    <Icon size={15} className="shrink-0 text-muted" />
                    <span className="min-w-0 truncate text-[13px] text-fg">
                      <Highlight text={entry.title} query={search} />
                    </span>
                    {/* The detail keeps its room (up to a third) however long the title is. */}
                    <span className="max-w-[33%] shrink-0 truncate text-[12px] text-faint">{entry.detail}</span>
                    <span className="flex-1" />
                    {entry.keys ? <Kbd>{entry.keys}</Kbd> : entry.aside && <span className="shrink-0 text-[11.5px] text-faint tabular-nums">{entry.aside}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <footer className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-[11.5px] text-faint">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↩</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>⌘K</Kbd> close
          </span>
        </footer>
      </div>
    </dialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="shrink-0 rounded border border-line px-1.5 font-mono text-[10.5px] leading-[18px] text-faint">{children}</kbd>;
}

/** The title with the characters the query matched in the accent color. */
function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(query, text);
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span key={start} className="text-accent">
        {text.slice(start, end)}
      </span>,
    );
    last = end;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Everything ⌘K can find, from the app state as it is now. */
function useEntries(): Entry[] {
  const projects = useApp((state) => state.projects);
  const chats = useOpenChats();
  const active = useApp((state) => state.active);
  const page = useApp((state) => state.page);
  const cards = useApp((state) => state.board.cards);
  const features = useApp((state) => state.settings.features);
  const pinned = usePinnedProjects();
  return useMemo(() => {
    const home = window.studio.homeDir;
    const now = Date.now();
    const current = active ? chats.find((chat) => chat.handle === active) : undefined;
    const groups = projectViews(projects, chats, pinned);
    const entries: Entry[] = [];

    for (const group of groups) {
      const project = baseName(group.cwd);
      for (const row of group.rows) {
        const live = row.live;
        const onScreen = Boolean(live && live.handle === active && !page);
        entries.push({
          id: `chat:${row.key}`,
          group: "Chats",
          icon: MessageSquare,
          title: live ? live.title : (row.summary?.title ?? "New chat"),
          detail: project,
          time: row.time,
          aside: onScreen ? "Open" : row.time ? relativeTime(row.time, now) : "",
          run: () => (live ? activate(live.handle) : row.summary && openSession(row.summary)),
        });
      }
    }

    if (features.kanban) {
      for (const card of cards) {
        entries.push({
          id: `card:${card.id}`,
          group: "Cards",
          icon: SquareKanban,
          title: card.title,
          detail: `${COLUMN_LABELS[card.column]} · ${baseName(card.cwd)}`,
          keywords: `${card.id} ${card.tags.join(" ")}`,
          time: card.updatedAt,
          run: () => showBoard(card.cwd, card.id),
        });
      }
    }

    const pages: [boolean, Entry][] = [
      [features.kanban, { id: "page:kanban", group: "Pages", icon: SquareKanban, title: "Kanban", keys: "⇧⌘K", keywords: "board cards tasks", run: () => showPage("kanban") }],
      [features.github, { id: "page:github", group: "Pages", icon: GitPullRequest, title: "GitHub", keys: "⇧⌘G", keywords: "issues pull requests prs review", run: () => showPage("github") }],
      [features.laments, { id: "page:laments", group: "Pages", icon: Angry, title: "Laments", keys: "⇧⌘L", keywords: "missing tools complaints", run: () => showPage("laments") }],
      [features.atp, { id: "page:atp", group: "Pages", icon: Network, title: "ATP", keys: "⇧⌘A", keywords: "plans graph agents", run: () => showPage("atp") }],
      [true, { id: "page:settings", group: "Pages", icon: Settings, title: "Settings", keys: "⌘,", keywords: "preferences options", run: () => openSettings() }],
    ];
    for (const [on, entry] of pages) if (on) entries.push(entry);

    for (const section of SECTIONS) {
      entries.push({
        id: `settings:${section.id}`,
        group: "Settings",
        icon: section.icon,
        title: section.label,
        keywords: section.keywords,
        run: () => openSettings(section.id),
      });
    }

    for (const group of groups) {
      entries.push({
        id: `project:${group.cwd}`,
        group: "Projects",
        icon: SquarePen,
        title: `New chat in ${baseName(group.cwd)}`,
        detail: tildify(group.cwd, home),
        run: () => newSession(group.cwd),
      });
    }

    const chat = current && !current.exited ? current : undefined;
    const commands: (Entry | false | undefined)[] = [
      { id: "cmd:new-chat", group: "Commands", icon: Plus, title: "New chat", keys: "⌘N", run: newChat },
      {
        id: "cmd:open-folder",
        group: "Commands",
        icon: FolderOpen,
        title: "New chat in folder…",
        keywords: "open project",
        run: () => void window.studio.pickFolder().then((folder) => folder && newSession(folder)),
      },
      chat && { id: "cmd:files", group: "Commands", icon: Files, title: "Find a file in the project", keys: "⌘P", keywords: "files open", run: showFileFinder },
      chat && { id: "cmd:open-file", group: "Commands", icon: FolderOpen, title: "Open file…", keys: "⌘O", keywords: "preview", run: () => void openFileDialog() },
      chat && { id: "cmd:browser", group: "Commands", icon: AppWindow, title: "Show or hide the browser", keys: "⌘B", keywords: "toggle pane web", run: toggleBrowser },
      { id: "cmd:sidebar", group: "Commands", icon: PanelLeftClose, title: "Show or hide the sidebar", keys: "⇧⌘S", keywords: "toggle", run: toggleSidebar },
      { id: "cmd:expand", group: "Commands", icon: ListChevronsUpDown, title: "Expand or collapse every tool call", keys: "⌃O", keywords: "toggle tools", run: toggleExpandAll },
      { id: "cmd:computer", group: "Commands", icon: MousePointerClick, title: "Computer use settings", keys: "⇧⌘U", run: () => openSettings("computer") },
      Boolean(chat?.sessionPath && features.kanban) &&
        chat && { id: "cmd:add-to-board", group: "Commands", icon: SquareKanban, title: "Add this chat to the board", keywords: "kanban card", run: () => void addChatToBoard(chat.handle) },
      current && {
        id: "cmd:pin",
        group: "Commands",
        icon: Pin,
        title: `${pinned.includes(projectOf(current.cwd)) ? "Unpin" : "Pin"} ${baseName(projectOf(current.cwd))}`,
        keywords: "project sidebar",
        run: () => togglePinnedProject(projectOf(current.cwd)),
      },
      chat && { id: "cmd:close-chat", group: "Commands", icon: X, title: "Close this chat", keywords: "stop end pi process", run: () => void closeSession(chat.handle) },
    ];
    for (const command of commands) if (command) entries.push(command);
    return entries;
  }, [projects, chats, active, page, cards, features, pinned]);
}
