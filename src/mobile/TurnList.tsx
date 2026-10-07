// The phone's replacement for the desktop's hover rail: a button over the transcript opens a sheet with one row per message
// you sent (and a star for the bookmarks the host keeps, so they match the desktop). A row scrolls there and flashes it.
import { ListTree, Star } from "../renderer/src/components/icons";
import { useMemo, useState } from "react";
import { useStore } from "../renderer/src/lib/store";
import { markdownText } from "../shared/markdown-text";
import type { TurnNav } from "../renderer/src/components/Transcript";
import type { HostClient } from "./client/host-client";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const NONE: number[] = [];

export function TurnList({ client, nav }: { client: HostClient; nav: TurnNav }) {
  const [open, setOpen] = useState(false);
  const [onlyMarked, setOnlyMarked] = useState(false);
  const marks = useStore(client.store, (s) => (nav.sessionPath ? (s.global.ui?.bookmarks[nav.sessionPath] ?? NONE) : NONE));
  const marked = useMemo(() => new Set(marks), [marks]);
  if (nav.items.length < 2) return null;
  const rows = onlyMarked ? nav.items.filter((item) => marked.has(item.at)) : nav.items;

  const toggle = (at: number) => {
    if (!nav.sessionPath) return;
    const op = { type: marked.has(at) ? "unbookmark" : "bookmark", session: nav.sessionPath, at } as const;
    client.call("ui.apply", { op }).catch((e) => toast(e instanceof Error ? e.message : String(e), "error"));
  };

  return (
    <>
      <button
        type="button"
        aria-label="Jump to a turn"
        data-testid="turn-list-button"
        onClick={() => setOpen(true)}
        className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full border border-line-strong bg-panel/90 text-muted shadow-[0_6px_20px_-6px_rgb(0_0_0/0.5)]"
      >
        <ListTree size={17} />
      </button>
      {open && (
        <Sheet title={`Turns (${nav.items.length})`} onClose={() => setOpen(false)} testId="turn-list">
          {marks.length > 0 && (
            <div className="px-4 pb-2">
              <button type="button" onClick={() => setOnlyMarked((on) => !on)} className={`rounded-full border px-3 py-1.5 text-[12.5px] ${onlyMarked ? "border-accent text-accent" : "border-line text-muted"}`}>
                Bookmarked ({marks.length})
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {rows.length === 0 && <div className="px-3 py-4 text-[13.5px] text-faint">No bookmarked turns.</div>}
            {rows.map((item) => (
              <div key={item.key} className="flex items-center">
                <button
                  type="button"
                  data-testid="turn-row"
                  onClick={() => {
                    setOpen(false);
                    void nav.jump(item.key);
                  }}
                  className="flex min-h-12 min-w-0 flex-1 flex-col justify-center rounded-xl px-3 text-left active:bg-raised"
                >
                  <span className="truncate text-[14.5px] text-fg">{item.label}</span>
                  {item.preview && <span className="truncate text-[12px] text-faint">{markdownText(item.preview).slice(0, 120)}</span>}
                </button>
                <button
                  type="button"
                  aria-label={marked.has(item.at) ? "Remove bookmark" : "Bookmark"}
                  aria-pressed={marked.has(item.at)}
                  onClick={() => toggle(item.at)}
                  className={`grid h-12 w-12 shrink-0 place-items-center ${marked.has(item.at) ? "text-warn" : "text-faint"}`}
                >
                  <Star size={17} fill={marked.has(item.at) ? "currentColor" : "none"} />
                </button>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
