// The input at a Kanban column's foot: describe a task, and paste, drop or pick screenshots (and files) to go with it.
import { FileText, Folder, ImagePlus, Plus, X } from "./icons";
import { useRef, useState } from "react";
import { type Column, LIMITS } from "../../../shared/board";
import { type Attachment, mergeAttachments } from "../lib/attachments";
import { addCard, openLightbox, pickFiles, readFiles } from "../state/app";

/**
 * Describe the task in your own words and press Enter: the card is titled with the start, and a quick chat in the
 * background names, tags and looks into it (addCard). Screenshots are saved with the card and listed by path in its
 * notes, with any files, for its chats to read. Stays open for the next card.
 */
export function AddCard({ column, cwd, open, onOpen }: { column: Column; cwd: string; open: boolean; onOpen: (column: Column | undefined) => void }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const setOpen = (next: boolean) => onOpen(next ? column : undefined);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-faint hover:bg-raised/60 hover:text-muted"
      >
        <Plus size={13} /> Add card
      </button>
    );
  }
  const empty = !text.trim() && !attachments.length;
  const attach = async (incoming: Promise<Attachment[]>) => {
    const added = await incoming;
    setAttachments((current) => mergeAttachments(current, added));
    area.current?.focus();
  };
  const submit = async () => {
    if (empty) return setOpen(false);
    if (busy) return;
    setBusy(true);
    const added = await addCard(cwd, column, text, attachments);
    setBusy(false);
    if (added) {
      setText("");
      setAttachments([]);
    }
  };
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <div
      // Files dropped here attach; a card dragged over it still lands in the column.
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        void attach(readFiles([...event.dataTransfer.files]));
      }}
      onBlur={(event) => {
        // Focus moving within the box, or to another window (the native picker), keeps it open.
        if (event.currentTarget.contains(event.relatedTarget as Node | null) || !document.hasFocus()) return;
        if (empty) setOpen(false);
      }}
      className="flex shrink-0 flex-col rounded-xl border border-accent/50 bg-panel"
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2.5 pt-2.5">
          {attachments.map((attachment) => (
            <Chip key={attachment.id} attachment={attachment} onRemove={() => setAttachments((current) => current.filter((a) => a.id !== attachment.id))} />
          ))}
        </div>
      )}
      <textarea
        ref={area}
        autoFocus
        value={text}
        maxLength={LIMITS.notes}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            setText("");
            setAttachments([]);
            setOpen(false);
          }
        }}
        // Cmd+V: a copied screenshot, or files copied in Finder. Text pastes as usual.
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!files.length) return;
          event.preventDefault();
          void attach(readFiles(files));
        }}
        placeholder="Describe the task · a quick chat titles, tags and looks into it"
        className="selectable max-h-48 min-h-[3.5rem] w-full resize-none bg-transparent px-3 pt-2 text-[13px] text-fg outline-none [field-sizing:content] placeholder:text-faint"
      />
      <div className="flex items-center gap-1 pr-1.5 pb-1.5 pl-3">
        <span className="flex-1 text-[11px] text-faint">{busy ? "Adding…" : "Paste or drop screenshots"}</span>
        <button
          type="button"
          title="Add screenshots"
          onClick={() => void attach(pickFiles("photos"))}
          className="grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-raised hover:text-fg"
        >
          <ImagePlus size={14} />
        </button>
      </div>
    </div>
  );
}

/** An attached image (click to enlarge) or file, with a remove button. */
function Chip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  return (
    <div className="group relative" title={attachment.path ?? attachment.name}>
      {attachment.kind === "image" ? (
        <button type="button" onClick={() => openLightbox(`data:${attachment.mimeType};base64,${attachment.data}`)} className="block cursor-zoom-in">
          <img alt={attachment.name} className="h-12 w-12 rounded-lg border border-line object-cover" src={`data:${attachment.mimeType};base64,${attachment.data}`} />
        </button>
      ) : (
        <div className="flex h-12 max-w-44 items-center gap-2 rounded-lg border border-line bg-sunken px-2.5">
          {attachment.isDir ? <Folder size={14} className="shrink-0 text-muted" /> : <FileText size={14} className="shrink-0 text-muted" />}
          <span className="truncate text-[12px] text-fg">
            {attachment.name}
            {attachment.isDir ? "/" : ""}
          </span>
        </div>
      )}
      <button
        type="button"
        title={`Remove ${attachment.name}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-line bg-panel p-0.5 text-muted hover:text-fg group-hover:block"
      >
        <X size={11} />
      </button>
    </div>
  );
}
