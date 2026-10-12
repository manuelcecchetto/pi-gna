// The empty chat's project: a pill with the path, the composer's color so it reads on any wallpaper, that opens the
// recent projects (the sidebar's, latest prompted first) and Open folder… for one that is not there yet. Shared by the
// desktop and the phone (Transcript's `projectPicker`).
import { useCallback, useState } from "react";
import { projectOf } from "../../../shared/board";
import type { ProjectGroup } from "../../../shared/ipc";
import { baseName, relativeTime, tildify } from "../lib/format";
import { Check, ChevronsUpDown, Folder, FolderOpen } from "./icons";
import { Popover } from "./primitives";

export interface ProjectPickerProps {
  projects: ProjectGroup[];
  onPick(cwd: string): void;
  /** Choose a folder that is not a project yet (the folder dialog, the phone's folder browser). */
  onBrowse(): void;
}

/** At most this many projects in the menu. */
const SHOWN = 8;

export function ProjectPicker({ cwd, home, projects, onPick, onBrowse }: ProjectPickerProps & { cwd: string; home: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const current = projectOf(cwd);
  const recent = [...projects].filter((project) => project.cwd !== current).sort((a, b) => b.promptedAt - a.promptedAt);
  const options = [{ cwd: current, promptedAt: 0 }, ...recent].slice(0, SHOWN);
  return (
    <div className="relative mt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Switch project"
        data-testid="switch-project"
        className={`flex max-w-full items-center gap-1.5 rounded-full border border-line-strong px-4 py-2 font-mono text-[13px] text-fg active:opacity-60 ${open ? "bg-raised" : "bg-panel hover:bg-raised"}`}
      >
        <span className="min-w-0 truncate">{tildify(cwd, home)}</span>
        <ChevronsUpDown size={14} className="shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={close} className="bottom-full left-1/2 mb-2 max-h-[60vh] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto p-1 text-left">
        {options.map((option) => (
          <button
            key={option.cwd}
            type="button"
            onClick={() => {
              setOpen(false);
              if (option.cwd !== current) onPick(option.cwd);
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-raised ${option.cwd === current ? "bg-raised" : ""}`}
          >
            <Folder size={14} className="shrink-0 text-faint" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] text-fg">{baseName(option.cwd) || "/"}</span>
              <span className="truncate font-mono text-[11px] text-faint">{tildify(option.cwd, home)}</span>
            </span>
            {option.cwd === current ? (
              <Check size={14} className="shrink-0 text-accent" />
            ) : (
              option.promptedAt > 0 && <span className="shrink-0 text-[11.5px] text-faint">{relativeTime(option.promptedAt)}</span>
            )}
          </button>
        ))}
        <div className="mx-1.5 my-1 h-px bg-line" />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onBrowse();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg hover:bg-raised"
        >
          <FolderOpen size={14} className="shrink-0 text-muted" />
          Open folder…
        </button>
      </Popover>
    </div>
  );
}
