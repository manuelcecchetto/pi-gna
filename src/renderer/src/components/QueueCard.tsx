// Queued messages as a card attached to the top of the composer (Codex-style). Steers wait for the
// current tool calls; follow-ups wait for the run to finish and can be steered in now.
import { CornerDownRight, Ellipsis, ListEnd, Pencil, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { splitFileMentions, stripStudioBlocks } from "../lib/attachments";
import type { QueueKind } from "../../../shared/queue";
import type { SessionState } from "../../../shared/session-state";
import { useChatActions } from "../lib/chat-ui";
import { Popover } from "./primitives";

/** `touch`: rows stack their actions as full-size buttons (Steer now, Edit, Remove) instead of icons and a menu. */
export function QueueCard({ session, onEdit, touch = false }: { session: SessionState; onEdit: (text: string) => void; touch?: boolean }) {
  const [busy, setBusy] = useState(false);
  const { editQueue } = useChatActions();
  const items = [
    ...session.queue.steering.map((text) => ({ kind: "steering" as QueueKind, text })),
    ...session.queue.followUp.map((text) => ({ kind: "followUp" as QueueKind, text })),
  ];
  if (!items.length) return null;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`relative z-[1] -mb-6 rounded-t-2xl border border-line-strong bg-raised px-1.5 pt-1 pb-5 ${touch ? "mx-3" : "mx-4"}`} data-testid="queue-card">
      {items.map((item, index) => (
        <QueueRow
          key={`${item.kind}:${index}:${item.text}`}
          kind={item.kind}
          text={item.text}
          busy={busy}
          touch={touch}
          onSteer={() => void run(() => editQueue(session.handle, { type: "move", kind: "followUp", text: item.text }))}
          onDefer={() => void run(() => editQueue(session.handle, { type: "move", kind: "steering", text: item.text }))}
          onDelete={() => void run(() => editQueue(session.handle, { type: "remove", kind: item.kind, text: item.text }))}
          onEdit={() =>
            void run(async () => {
              if (await editQueue(session.handle, { type: "remove", kind: item.kind, text: item.text })) onEdit(item.text);
            })
          }
        />
      ))}
    </div>
  );
}

function QueueRow({
  kind,
  text,
  busy,
  touch,
  onSteer,
  onDefer,
  onDelete,
  onEdit,
}: {
  kind: QueueKind;
  text: string;
  busy: boolean;
  touch: boolean;
  onSteer: () => void;
  onDefer: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const close = useCallback(() => setMenu(false), []);
  const [withoutFiles, files] = splitFileMentions(text);
  const shown = stripStudioBlocks(withoutFiles) || (files.length ? "(attachments)" : text);
  const steering = kind === "steering";
  if (touch) {
    const action = "flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-fg disabled:opacity-50";
    return (
      <div className="flex min-w-0 flex-col gap-2 rounded-lg px-2 py-2" data-testid="queue-row" data-kind={kind}>
        <div className="flex min-w-0 items-center gap-2.5">
          {steering ? <CornerDownRight size={15} className="shrink-0 text-accent" /> : <ListEnd size={15} className="shrink-0 text-faint" />}
          <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{shown}</span>
          {files.length > 0 && <span className="shrink-0 text-[11.5px] text-faint">+{files.length} {files.length === 1 ? "file" : "files"}</span>}
          <span className="shrink-0 text-[12px] text-faint">{steering ? "Steering" : "After the run"}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {steering ? (
            <button type="button" disabled={busy} onClick={onDefer} className={action} data-testid="queue-defer">
              <ListEnd size={14} /> After the run
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={onSteer} className={action} data-testid="queue-steer">
              <CornerDownRight size={14} /> Steer now
            </button>
          )}
          <button type="button" disabled={busy} onClick={onEdit} className={action} data-testid="queue-edit">
            <Pencil size={14} /> Edit
          </button>
          <button type="button" disabled={busy} onClick={onDelete} className={`${action} text-bad`} data-testid="queue-delete">
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5" title={steering ? "Delivered after the current tool calls" : "Sent when the run finishes"}>
      {steering ? <CornerDownRight size={14} className="shrink-0 text-accent" /> : <ListEnd size={14} className="shrink-0 text-faint" />}
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{shown}</span>
      {files.length > 0 && <span className="shrink-0 text-[11.5px] text-faint">+{files.length} {files.length === 1 ? "file" : "files"}</span>}
      {steering ? (
        <span className="shrink-0 text-[12px] text-faint">Steering</span>
      ) : (
        <button type="button" disabled={busy} onClick={onSteer} className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-muted hover:bg-raised hover:text-fg disabled:opacity-50">
          <CornerDownRight size={13} /> Steer
        </button>
      )}
      <button type="button" disabled={busy} title="Remove" onClick={onDelete} className="shrink-0 rounded-md p-1 text-faint hover:bg-raised hover:text-fg disabled:opacity-50">
        <Trash2 size={13} />
      </button>
      <div className="relative shrink-0">
        <button type="button" disabled={busy} title="More" onClick={() => setMenu(!menu)} className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg disabled:opacity-50">
          <Ellipsis size={14} />
        </button>
        <Popover open={menu} onClose={close} className="right-0 bottom-full mb-1.5 w-52 p-1">
          <MenuItem
            icon={<Pencil size={13} />}
            label="Edit in composer"
            onClick={() => {
              setMenu(false);
              onEdit();
            }}
          />
          {steering && (
            <MenuItem
              icon={<ListEnd size={13} />}
              label="Send after the run instead"
              onClick={() => {
                setMenu(false);
                onDefer();
              }}
            />
          )}
        </Popover>
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg hover:bg-raised">
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}
