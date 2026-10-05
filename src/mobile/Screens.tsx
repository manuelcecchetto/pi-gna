// Projects and Chats: the two list screens above a chat.
import { ChevronLeft, ChevronRight, FolderOpen, Globe, Pin, Search, Settings, SquarePen } from "lucide-react";
import { useState } from "react";
import { useStore } from "../renderer/src/lib/store";
import { relativeTime, tildify } from "../renderer/src/lib/format";
import type { Attention } from "../shared/session-state";
import { cardOfChat, freshId, LIMITS, projectOf } from "../shared/board";
import { emptySettings } from "../shared/settings";
import { type ChatAction, chatActions, type ProjectAction, projectActions } from "./actions";
import { type ChatItem, chatItems, projectItems, type ProjectItem, searchChats, searchProjects } from "./chat-list";
import { useLongPress } from "./long-press";
import { ChatSheet, ConfirmClose, FolderPicker, ProjectSheet } from "./ProjectSheets";
import { markSeen, useSeen } from "./seen";
import { toast } from "./toasts";
import type { HostClient } from "./client/host-client";
import type { Route } from "./nav";

const MARKS: Record<Exclude<Attention, "idle">, { label: string; color: string; pulse?: boolean }> = {
  waiting: { label: "Waiting for you", color: "var(--accent)", pulse: true },
  running: { label: "Working", color: "var(--ok)", pulse: true },
  failed: { label: "Failed", color: "var(--bad)" },
  unread: { label: "New activity", color: "var(--accent)" },
};

export function Mark({ level }: { level?: Attention }) {
  if (!level || level === "idle") return null;
  const mark = MARKS[level];
  return <span role="img" aria-label={mark.label} title={mark.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${mark.pulse ? "animate-pulse" : ""}`} style={{ background: mark.color }} />;
}

export function Header({ title, subtitle, onBack, trailing }: { title: string; subtitle?: string; onBack?: () => void; trailing?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1">
      {onBack ? (
        <button type="button" aria-label="Back" onClick={onBack} className="grid h-11 w-11 shrink-0 place-items-center text-muted active:text-fg">
          <ChevronLeft size={22} />
        </button>
      ) : (
        <div className="w-3 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium text-fg">{title}</div>
        {subtitle && <div className="truncate font-mono text-[11px] text-faint">{subtitle}</div>}
      </div>
      {trailing}
    </header>
  );
}

const row = "flex min-h-14 w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left active:bg-raised";
const name = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) ?? cwd;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function copy(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast("Copied"),
    () => toast("Could not copy", "warning"),
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
      <Search size={15} className="shrink-0 text-faint" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        className="min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-faint"
        data-testid="search"
      />
    </div>
  );
}

const IconButton = ({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId: string }) => (
  <button type="button" aria-label={label} onClick={onClick} className="grid h-11 w-11 shrink-0 place-items-center text-muted active:text-fg" data-testid={testId}>
    {children}
  </button>
);

/** Feature switches as the Mac has them; before settings arrive, the defaults. */
function useFeatures(client: HostClient) {
  return useStore(client.store, (s) => s.global.settings?.features) ?? emptySettings().features;
}

function ProjectRow({ item, homeDir, onOpen, onMenu }: { item: ProjectItem; homeDir: string; onOpen: () => void; onMenu: () => void }) {
  const press = useLongPress(onMenu);
  const { guard, ...handlers } = press;
  return (
    <button type="button" className={row} onClick={guard(onOpen)} {...handlers} data-testid="project-row">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[15px] text-fg">
          {item.pinned && <Pin size={12} className="shrink-0 text-faint" />}
          <span className="truncate">{name(item.cwd)}</span>
        </div>
        <div className="truncate font-mono text-[11px] text-faint">{tildify(item.cwd, homeDir)}</div>
      </div>
      <Mark level={item.attention} />
      <span className="shrink-0 text-[12px] text-faint">{item.chats}</span>
      <ChevronRight size={16} className="shrink-0 text-faint" />
    </button>
  );
}

export function Projects({ client, homeDir, push, footer }: { client: HostClient; homeDir: string; push: (route: Route) => void; footer?: React.ReactNode }) {
  const projects = useStore(client.store, (s) => s.global.projects);
  const pins = useStore(client.store, (s) => s.global.ui?.pins);
  const attention = useStore(client.store, (s) => s.global.attention);
  const features = useFeatures(client);
  const seen = useSeen();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ProjectItem>();
  const [picking, setPicking] = useState(false);
  const all = projects ? projectItems(projects, pins ?? [], attention, seen) : undefined;
  const items = all && searchProjects(all, query);

  const newChat = (cwd: string) => push({ screen: "chat", cwd: projectOf(cwd) });
  const act = (item: ProjectItem, action: ProjectAction) => {
    setMenu(undefined);
    if (action === "new-chat") newChat(item.cwd);
    else if (action === "pin" || action === "unpin") {
      client.call("ui.apply", { op: { type: action, cwd: item.cwd } }).catch((e) => toast(message(e), "error"));
    } else if (action === "copy-path") copy(item.cwd);
    else push({ screen: "page", page: action, cwd: item.cwd });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title="Projects"
        trailing={
          <>
            <IconButton label="Open a folder" onClick={() => setPicking(true)} testId="open-folder">
              <FolderOpen size={20} />
            </IconButton>
            <IconButton label="Browser" onClick={() => push({ screen: "browser" })} testId="open-browser">
              <Globe size={20} />
            </IconButton>
            <IconButton label="Settings" onClick={() => push({ screen: "settings" })} testId="open-settings">
              <Settings size={20} />
            </IconButton>
          </>
        }
      />
      <SearchBox value={query} onChange={setQuery} placeholder="Search projects and chats" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!items && <div className="p-6 text-center text-[13.5px] text-faint">Loading…</div>}
        {all?.length === 0 && <div className="p-6 text-center text-[13.5px] text-faint">No sessions yet. Open a folder to start one.</div>}
        {all && all.length > 0 && items?.length === 0 && <div className="p-6 text-center text-[13.5px] text-faint">No project matches.</div>}
        {items?.map((item) => (
          <ProjectRow key={item.cwd} item={item} homeDir={homeDir} onOpen={() => push({ screen: "chats", cwd: item.cwd })} onMenu={() => setMenu(item)} />
        ))}
        {footer}
      </div>
      {menu && <ProjectSheet title={name(menu.cwd)} actions={projectActions(features, menu.pinned)} onAction={(action) => act(menu, action)} onClose={() => setMenu(undefined)} />}
      {picking && (
        <FolderPicker
          client={client}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false);
            newChat(path);
          }}
        />
      )}
    </div>
  );
}

function ChatRow({ item, onOpen, onMenu }: { item: ChatItem; onOpen: () => void; onMenu: () => void }) {
  const { guard, ...handlers } = useLongPress(onMenu);
  return (
    <button type="button" className={row} onClick={guard(onOpen)} {...handlers} data-testid="chat-row">
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[15px] text-fg">{item.title}</div>
        {item.time !== undefined && <div className="font-mono text-[11px] text-faint">{relativeTime(item.time)}</div>}
      </div>
      <Mark level={item.attention} />
      <ChevronRight size={16} className="shrink-0 text-faint" />
    </button>
  );
}

export function Chats({ client, homeDir, cwd, push, back }: { client: HostClient; homeDir: string; cwd: string; push: (route: Route) => void; back: () => void }) {
  const projects = useStore(client.store, (s) => s.global.projects);
  const pins = useStore(client.store, (s) => s.global.ui?.pins);
  const attention = useStore(client.store, (s) => s.global.attention);
  const board = useStore(client.store, (s) => s.global.board);
  const features = useFeatures(client);
  const seen = useSeen();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ChatItem>();
  const [closing, setClosing] = useState<ChatItem>();
  const all = projects ? chatItems(projects, pins ?? [], attention, cwd, seen) : undefined;
  const items = all && searchChats(all, query);

  const open = (item: ChatItem) => {
    markSeen(item.handle, item.settledAt);
    push({ screen: "chat", cwd, sessionPath: item.path, handle: item.handle, title: item.title });
  };
  const cardOf = (item: ChatItem) => (board ? cardOfChat(board, item.path) : undefined);
  const act = (item: ChatItem, action: ChatAction) => {
    setMenu(undefined);
    const card = cardOf(item);
    if (action === "open") open(item);
    else if (action === "copy-path") copy(item.path);
    else if (action === "close") setClosing(item);
    else if (action === "show-board" && card) push({ screen: "page", page: "board", cwd: card.cwd, cardId: card.id });
    else if (action === "add-board" && board) {
      const id = freshId(board);
      const title = item.title.slice(0, LIMITS.title);
      void (async () => {
        try {
          await client.call("board.apply", { op: { type: "add", id, title, cwd: projectOf(cwd), column: "in_progress" }, baseRev: board.rev });
          await client.call("board.apply", { op: { type: "attach", id, chat: { path: item.path, cwd, label: title } } });
          toast("Added to the board");
        } catch (e) {
          toast(message(e), "error");
        }
      })();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title={name(cwd)}
        subtitle={tildify(cwd, homeDir)}
        onBack={back}
        trailing={
          <IconButton label="New chat" onClick={() => push({ screen: "chat", cwd })} testId="new-chat">
            <SquarePen size={20} />
          </IconButton>
        }
      />
      <SearchBox value={query} onChange={setQuery} placeholder="Search chats" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {all?.length === 0 && <div className="p-6 text-center text-[13.5px] text-faint">No chats in this project.</div>}
        {all && all.length > 0 && items?.length === 0 && <div className="p-6 text-center text-[13.5px] text-faint">No chat matches.</div>}
        {items?.map((item) => (
          <ChatRow key={item.path} item={item} onOpen={() => open(item)} onMenu={() => setMenu(item)} />
        ))}
      </div>
      {menu && (
        <ChatSheet
          title={menu.title}
          cardTitle={cardOf(menu)?.title}
          actions={chatActions({ kanban: features.kanban, live: menu.handle !== undefined, card: cardOf(menu), addable: menu.handle !== undefined && !!board })}
          onAction={(action) => act(menu, action)}
          onClose={() => setMenu(undefined)}
        />
      )}
      {closing && (
        <ConfirmClose
          title={closing.title}
          onClose={() => setClosing(undefined)}
          onConfirm={() => {
            const handle = closing.handle;
            setClosing(undefined);
            if (handle) client.call("chat.close", { handle }).catch((e) => toast(message(e), "error"));
          }}
        />
      )}
    </div>
  );
}

const PAGE_TITLES = { board: "Kanban board", laments: "Laments", github: "GitHub", atp: "ATP plans" } as const;

/** Where a project page will be; the pages arrive with their own nodes. */
export function PageSoon({ route, back }: { route: Extract<Route, { screen: "page" }>; back: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={PAGE_TITLES[route.page]} subtitle={name(route.cwd)} onBack={back} />
      <div className="p-6 text-center text-[13.5px] text-faint">This page is not on the phone yet. Use the Mac for now.</div>
    </div>
  );
}
