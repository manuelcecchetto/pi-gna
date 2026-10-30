// One row of the sidebar's fixed lists (New chat, the pages, Settings, the Settings sections), on the sidebar's grid:
// 32px tall, the icon 16px from the window edge and the label 8px after it. The grid is in px, not Tailwind's rem
// spacing (3.5px a step at the 14px root): the icons and the sidebar's text are px, and the rows must line up with them. Collapsed to the rail, the row keeps its
// icon where it was and only its label fades, so the icons never move.
import type { IconComponent } from "./icons";
import { useApp } from "../state/app";

/** The collapsed sidebar: wide enough for one 32px row and 8px either side, so an icon sits 16px from each edge. */
export const SIDEBAR_RAIL = 48;

/** What fades out on the rail: fades, then stops taking clicks and focus. */
export const RAIL_FADE = "transition-[opacity,visibility] duration-150 group-data-rail/side:invisible group-data-rail/side:opacity-0";

export function NavRow({
  icon: Icon,
  label,
  shortcut,
  active = false,
  badge,
  trailing,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  /** Shown on hover, and in the rail's tooltip. */
  shortcut?: string;
  active?: boolean;
  /** A status shown instead of the shortcut until hover (a count, a mark). */
  badge?: React.ReactNode;
  /** Shown at the end in place of the shortcut (a ⌘ digit). */
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  const rail = useApp((state) => state.sidebar.collapsed);
  return (
    <button
      type="button"
      onClick={onClick}
      title={rail ? (shortcut ? `${label} (${shortcut})` : label) : undefined}
      aria-label={label}
      className={`group flex h-[32px] w-full shrink-0 items-center gap-[8px] overflow-hidden rounded-lg px-[8px] text-left text-[14px] transition-[width] duration-200 ease-out group-data-rail/side:w-[32px] ${active ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
    >
      <Icon size={16} className="shrink-0 text-muted" />
      <span className={`flex min-w-0 flex-1 items-center gap-[8px] whitespace-nowrap ${RAIL_FADE}`}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge && <span className="flex items-center gap-1 group-hover:hidden">{badge}</span>}
        {trailing ??
          (shortcut && <span className={`font-mono text-[11px] text-faint ${badge ? "hidden group-hover:inline" : "opacity-0 group-hover:opacity-100"}`}>{shortcut}</span>)}
      </span>
    </button>
  );
}
