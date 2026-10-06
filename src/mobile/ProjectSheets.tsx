// The phone's project and chat menus: folder browser for opening a project, and the long-press sheets that mirror the
// desktop sidebar's context menus (actions.ts decides which rows).
import { Check, ChevronLeft, Copy, Eye, EyeOff, Folder, MessagesSquare, Pin, PinOff, SquareKanban, SquarePen, X, Angry, GitPullRequest, Network } from "../renderer/src/components/icons";
import { useEffect, useState } from "react";
import type { FolderListing } from "../shared/host-api";
import type { ChatAction, ProjectAction } from "./actions";
import type { HostClient } from "./client/host-client";
import { Sheet } from "./Sheets";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const rowClass = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-fg active:bg-raised";

/** Pick a folder on the Mac to open as a project: directories only, from the home folder down, hidden ones behind a toggle. */
export function FolderPicker({ client, onClose, onPick }: { client: HostClient; onClose: () => void; onPick: (path: string) => void }) {
  const [listing, setListing] = useState<FolderListing>();
  const [path, setPath] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setError(undefined);
    void client
      .call("fs.browseFolders", { path, hidden })
      .then((next) => alive && setListing(next))
      .catch((e) => alive && setError(failure(e)));
    return () => {
      alive = false;
    };
  }, [client, path, hidden]);
  return (
    <Sheet title="Open a folder" onClose={onClose} testId="folder-picker">
      <div className="flex items-center gap-2 px-3 pb-2">
        <button type="button" aria-label="Up" disabled={!listing?.parent} onClick={() => setPath(listing?.parent ?? undefined)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted disabled:opacity-30">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint">{listing?.path ?? "…"}</span>
        <button type="button" aria-label={hidden ? "Hide hidden folders" : "Show hidden folders"} aria-pressed={hidden} onClick={() => setHidden((on) => !on)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted" data-testid="toggle-hidden">
          {hidden ? <Eye size={17} /> : <EyeOff size={17} />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error && <div className="px-3 py-4 text-[13.5px] text-bad">{error}</div>}
        {listing?.folders.map((f) => (
          <button key={f.path} type="button" className={rowClass} onClick={() => setPath(f.path)} data-testid="host-folder">
            <Folder size={17} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate">{f.name}</span>
          </button>
        ))}
        {listing && !listing.folders.length && <div className="px-3 py-4 text-[13.5px] text-faint">No folders here.</div>}
      </div>
      <div className="px-4 pt-2">
        <button type="button" disabled={!listing} onClick={() => listing && onPick(listing.path)} className="min-h-12 w-full rounded-xl bg-accent px-4 text-[15px] font-medium text-white disabled:opacity-40" data-testid="open-this-folder">
          Start a chat here
        </button>
      </div>
    </Sheet>
  );
}

function Item({ icon, label, hint, danger, onClick, testId }: { icon: React.ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={onClick} className={`${rowClass} ${danger ? "text-bad" : ""}`} data-testid={testId}>
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-[11.5px] text-faint">{hint}</span>}
      </span>
    </button>
  );
}

export function ChatSheet({ title, actions, cardTitle, onAction, onClose }: { title: string; actions: ChatAction[]; cardTitle?: string; onAction: (action: ChatAction) => void; onClose: () => void }) {
  const items: Record<ChatAction, React.ReactNode> = {
    open: <Item key="open" testId="act-open" icon={<MessagesSquare size={17} />} label="Open" onClick={() => onAction("open")} />,
    "show-board": <Item key="show" testId="act-show-board" icon={<SquareKanban size={17} />} label="Show on the board" hint={cardTitle} onClick={() => onAction("show-board")} />,
    "add-board": <Item key="add" testId="act-add-board" icon={<SquareKanban size={17} />} label="Add to the board" onClick={() => onAction("add-board")} />,
    close: <Item key="close" testId="act-close" icon={<X size={17} />} label="Close chat" hint="Stops its pi process" danger onClick={() => onAction("close")} />,
    "copy-path": <Item key="copy" testId="act-copy-path" icon={<Copy size={17} />} label="Copy path" onClick={() => onAction("copy-path")} />,
  };
  return (
    <Sheet title={title} onClose={onClose} testId="chat-sheet">
      <div className="px-2 pb-2">{actions.map((action) => items[action])}</div>
    </Sheet>
  );
}

export function ProjectSheet({ title, actions, onAction, onClose }: { title: string; actions: ProjectAction[]; onAction: (action: ProjectAction) => void; onClose: () => void }) {
  const items: Record<ProjectAction, React.ReactNode> = {
    "new-chat": <Item key="new" testId="act-new-chat" icon={<SquarePen size={17} />} label="New chat" onClick={() => onAction("new-chat")} />,
    pin: <Item key="pin" testId="act-pin" icon={<Pin size={17} />} label="Pin project" onClick={() => onAction("pin")} />,
    unpin: <Item key="unpin" testId="act-unpin" icon={<PinOff size={17} />} label="Unpin project" onClick={() => onAction("unpin")} />,
    board: <Item key="board" testId="act-board" icon={<SquareKanban size={17} />} label="Kanban board" onClick={() => onAction("board")} />,
    laments: <Item key="laments" testId="act-laments" icon={<Angry size={17} />} label="Laments" onClick={() => onAction("laments")} />,
    github: <Item key="github" testId="act-github" icon={<GitPullRequest size={17} />} label="GitHub issues and PRs" onClick={() => onAction("github")} />,
    atp: <Item key="atp" testId="act-atp" icon={<Network size={17} />} label="ATP plans" onClick={() => onAction("atp")} />,
    "copy-path": <Item key="copy" testId="act-copy-path" icon={<Copy size={17} />} label="Copy path" onClick={() => onAction("copy-path")} />,
  };
  return (
    <Sheet title={title} onClose={onClose} testId="project-sheet">
      <div className="px-2 pb-2">{actions.map((action) => items[action])}</div>
    </Sheet>
  );
}

/** "Close chat" stops pi, so it asks first. */
export function ConfirmClose({ title, onConfirm, onClose }: { title: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet title="Close this chat?" onClose={onClose} testId="confirm-close">
      <div className="px-4 pb-2">
        <p className="pb-3 text-[13.5px] text-muted">
          <span className="text-fg">{title}</span> stops its pi process on the Mac, including anything it is running. The conversation stays in the list.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="min-h-12 flex-1 rounded-xl border border-line text-[15px] text-fg">
            Keep running
          </button>
          <button type="button" onClick={onConfirm} className="flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-xl bg-bad text-[15px] font-medium text-white" data-testid="confirm-close-go">
            <Check size={16} /> Close chat
          </button>
        </div>
      </div>
    </Sheet>
  );
}
