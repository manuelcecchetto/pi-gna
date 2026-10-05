// The composer's attachment UI: chips for what is attached, the + sheet (photos, files, host files) and the host file browser.
import { ChevronLeft, File, FileImage, Folder, Image, Loader2, Monitor, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FolderListing } from "../shared/host-api";
import type { HostClient } from "./client/host-client";
import { type Attached } from "./attach-state";
import { Sheet } from "./Sheets";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function AttachmentChips({ list, onRemove }: { list: Attached[]; onRemove: (key: string) => void }) {
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" data-testid="attachment-chips">
      {list.map((a) => (
        <span key={a.key} className={`flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border px-2 text-[12.5px] ${a.state === "error" ? "border-bad/50 text-bad" : "border-line text-muted"}`} data-testid="attachment-chip" title={a.error}>
          {a.state === "uploading" ? <Loader2 size={13} className="shrink-0 animate-spin" /> : a.isDir ? <Folder size={13} className="shrink-0" /> : a.image ? <FileImage size={13} className="shrink-0" /> : <File size={13} className="shrink-0" />}
          <span className="min-w-0 truncate">{a.name}</span>
          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.key)} className="grid h-8 w-6 shrink-0 place-items-center">
            <X size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** The + sheet. The inputs are real file inputs: iOS offers the photo library and the camera for images, the Files app for files. */
export function AttachSheet({ onClose, onFiles, onHost }: { onClose: () => void; onFiles: (files: File[]) => void; onHost: () => void }) {
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const picked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = [...(event.target.files ?? [])];
    event.target.value = "";
    onClose();
    if (list.length) onFiles(list);
  };
  const row = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-fg";
  return (
    <Sheet title="Attach" onClose={onClose} testId="attach-sheet">
      <div className="px-2 pb-2">
        <button type="button" className={row} onClick={() => photos.current?.click()} data-testid="attach-photos">
          <Image size={18} className="text-muted" /> Photos
        </button>
        <button type="button" className={row} onClick={() => files.current?.click()} data-testid="attach-files">
          <Paperclip size={18} className="text-muted" /> Files
        </button>
        <button type="button" className={row} onClick={onHost} data-testid="attach-host">
          <Monitor size={18} className="text-muted" /> Files and folders on the Mac
        </button>
        <input ref={photos} type="file" accept="image/*" multiple hidden onChange={picked} data-testid="photo-input" />
        <input ref={files} type="file" multiple hidden onChange={picked} data-testid="file-input" />
      </div>
    </Sheet>
  );
}

/** Browse the host below the home folder; tap a file to attach it, or attach the folder you are in. */
export function HostFilesSheet({ client, onClose, onPick }: { client: HostClient; onClose: () => void; onPick: (item: { name: string; path: string; isDir: boolean }) => void }) {
  const [listing, setListing] = useState<FolderListing>();
  const [path, setPath] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setError(undefined);
    void client
      .call("fs.browseFolders", { path, files: true })
      .then((next) => alive && setListing(next))
      .catch((e) => alive && setError(failure(e)));
    return () => {
      alive = false;
    };
  }, [client, path]);
  const row = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-fg";
  const here = listing && { name: listing.path.split("/").pop() || listing.path, path: listing.path, isDir: true };
  return (
    <Sheet title="On the Mac" onClose={onClose} testId="host-files-sheet">
      <div className="flex items-center gap-2 px-3 pb-2">
        <button type="button" aria-label="Up" disabled={!listing?.parent} onClick={() => setPath(listing?.parent ?? undefined)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted disabled:opacity-30">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint">{listing?.path ?? "…"}</span>
        {here && (
          <button type="button" onClick={() => onPick(here)} className="shrink-0 rounded-lg border border-line px-3 py-2 text-[13px] text-fg" data-testid="attach-this-folder">
            Attach folder
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error && <div className="px-3 py-4 text-[13.5px] text-bad">{error}</div>}
        {listing?.folders.map((f) => (
          <button key={f.path} type="button" className={row} onClick={() => setPath(f.path)} data-testid="host-folder">
            <Folder size={17} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate">{f.name}</span>
          </button>
        ))}
        {listing?.files?.map((f) => (
          <button key={f.path} type="button" className={row} onClick={() => onPick({ ...f, isDir: false })} data-testid="host-file">
            <File size={17} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate">{f.name}</span>
          </button>
        ))}
        {listing && !listing.folders.length && !listing.files?.length && <div className="px-3 py-4 text-[13.5px] text-faint">Nothing here.</div>}
      </div>
    </Sheet>
  );
}
