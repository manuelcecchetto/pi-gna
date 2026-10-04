import { Globe, ListChevronsDownUp, ListChevronsUpDown, Paperclip, SquareKanban } from "lucide-react";
import { useRef, useState } from "react";
import { cardOfChat } from "../../../shared/board";
import { isDraft, type SessionState } from "../../../shared/session-state";
import { addChatToBoard, attachFiles, sessionTitle, showBoard, toggleBrowser, toggleExpandAll, useApp, useFeature } from "../state/app";
import { ColumnIcon } from "./ColumnIcon";
import { Composer } from "./Composer";
import { COLLAPSED_INSET } from "./Sidebar";
import { Transcript } from "./Transcript";

export function SessionPane({ session }: { session: SessionState }) {
  const expandAll = useApp((state) => state.expandAll);
  const browserOpen = useApp((state) => state.pane.open);
  const inset = useApp((state) => state.sidebar.collapsed);
  const kanban = useFeature("kanban");
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
      <header className="drag dashed-b flex h-[52px] shrink-0 items-center gap-3 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-fg">{sessionTitle(session)}</div>
        </div>
        {kanban && <CardChip session={session} />}
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
          title={expandAll ? "Collapse the transcript's steps (Ctrl+O)" : "Expand the transcript's steps (Ctrl+O)"}
          className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg"
        >
          {expandAll ? <ListChevronsDownUp size={15} /> : <ListChevronsUpDown size={15} />}
        </button>
      </header>
      {session.phase === "exited" && <ExitBanner session={session} />}
      <Transcript session={session} />
      <Composer session={session} />
    </div>
  );
}

/** The card this chat works on (opens it on the board), or a button to put the chat on the board. */
function CardChip({ session }: { session: SessionState }) {
  const card = useApp((state) => (session.sessionPath ? cardOfChat(state.board, session.sessionPath) : undefined));
  if (card) {
    return (
      <button
        type="button"
        onClick={() => showBoard(card.cwd, card.id)}
        title={`On the board: ${card.title}`}
        className="flex max-w-60 min-w-0 items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-0.5 text-[12px] text-muted hover:bg-raised hover:text-fg"
      >
        <ColumnIcon column={card.column} size={12} />
        <span className="truncate">{card.title}</span>
      </button>
    );
  }
  if (!session.sessionPath || isDraft(session) || session.phase === "exited") return null;
  return (
    <button type="button" onClick={() => void addChatToBoard(session.handle)} title="Add to the Kanban board" className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg">
      <SquareKanban size={15} />
    </button>
  );
}

function ExitBanner({ session }: { session: SessionState }) {
  const exit = session.exit;
  return (
    <div className="border-b border-bad/30 bg-bad/5 px-5 py-2 text-[12.5px]">
      {exit?.error ? (
        <>
          <span className="text-bad">pi could not start.</span>
          <span className="selectable text-muted"> {exit.error}</span>
        </>
      ) : (
        <>
          <span className="text-bad">pi exited</span>
          <span className="text-muted"> ({exit?.signal ?? `code ${exit?.code}`}). The transcript is read-only; reopen the session from the sidebar.</span>
        </>
      )}
      {exit?.stderrTail && <pre className="selectable mt-1.5 max-h-28 overflow-auto font-mono text-[11px] text-faint">{exit.stderrTail.trim().split("\n").slice(-8).join("\n")}</pre>}
    </div>
  );
}
