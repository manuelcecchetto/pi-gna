// A menu at a point (right click, or under a "…" button). Sections are separated by a hairline.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { setOverlay } from "../state/app";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** Shown as a tooltip. */
  hint?: string;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * Right-click menus for the window's own objects (chats, projects, tabs): call `open` from onContextMenu, which
 * cancels the native menu (main's context-menu.ts, for text, links and images), and render `menu`.
 */
export function useContextMenu() {
  const [shown, setShown] = useState<{ at: { x: number; y: number }; sections: MenuItem[][] }>();
  const close = useCallback(() => setShown(undefined), []);
  const open = useCallback((event: React.MouseEvent, sections: MenuItem[][]) => {
    event.preventDefault();
    setShown({ at: { x: event.clientX, y: event.clientY }, sections });
  }, []);
  return { open, menu: shown && <ContextMenu at={shown.at} sections={shown.sections} onClose={close} /> };
}

export function ContextMenu({ at, sections, onClose }: { at: { x: number; y: number }; sections: MenuItem[][]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  // Keep it inside the window, flipping up or left near an edge.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      x: at.x + width > window.innerWidth - 8 ? Math.max(8, at.x - width) : at.x,
      y: at.y + height > window.innerHeight - 8 ? Math.max(8, at.y - height) : at.y,
    });
    menu.querySelector("button")?.focus();
  }, [at]);

  useEffect(() => {
    setOverlay(true); // the native browser view would draw over the menu
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...(ref.current?.querySelectorAll("button") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      setOverlay(false);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const visible = sections.filter((section) => section.length);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 max-w-80 min-w-52 rounded-xl border border-line-strong bg-panel p-1 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {visible.map((section, index) => (
        <div key={index} className={index ? "mt-1 border-t border-line pt-1" : ""}>
          {section.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              title={item.hint}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] outline-none hover:bg-raised focus-visible:bg-raised ${item.danger ? "text-bad" : "text-fg"}`}
            >
              {item.icon && <span className={`grid w-3.5 shrink-0 place-items-center ${item.danger ? "" : "text-muted"}`}>{item.icon}</span>}
              <span className="flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
