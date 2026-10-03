// A page header's project picker: the same page (board, laments) of another project.
import { ChevronDown, Folder } from "lucide-react";
import { useCallback, useState } from "react";
import { baseName, tildify } from "../lib/format";
import { Popover } from "./primitives";

/** A project to switch to, with how many of its items are open (cards not done, laments not resolved). */
export interface ProjectOption {
  cwd: string;
  open: number;
}

export function ProjectSwitch({ cwd, options, openTitle, onPick }: { cwd: string; options: ProjectOption[]; openTitle: string; onPick: (cwd: string) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const home = window.studio.homeDir;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={tildify(cwd, home)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-muted hover:bg-raised hover:text-fg"
      >
        <Folder size={13} className="text-faint" />
        {baseName(cwd) || "/"}
        <ChevronDown size={12} className="text-faint" />
      </button>
      <Popover open={open} onClose={close} className="top-full left-0 mt-1 max-h-96 w-80 overflow-y-auto p-1">
        {options.map((option) => (
          <button
            key={option.cwd}
            type="button"
            onClick={() => {
              setOpen(false);
              onPick(option.cwd);
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-raised ${option.cwd === cwd ? "bg-raised/60" : ""}`}
          >
            <Folder size={13} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
              {baseName(option.cwd) || "/"} <span className="text-faint">{tildify(option.cwd, home)}</span>
            </span>
            {option.open > 0 && (
              <span className="font-mono text-[11px] text-faint" title={openTitle}>
                {option.open}
              </span>
            )}
          </button>
        ))}
      </Popover>
    </div>
  );
}
