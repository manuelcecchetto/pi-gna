// A row that opens on tap and offers its menu on a long press (or the context-menu gesture); the tap that ends a long
// press must not also open the row.
import { useRef } from "react";

const HOLD_MS = 450;
const SLOP_PX = 10;

export function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    onPointerDown: (event: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      cancel();
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        onLong();
      }, HOLD_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      if (!fired.current) onLong();
    },
    /** Wrap the row's own onClick: a click that follows a long press is swallowed. */
    guard: (click: () => void) => () => {
      if (fired.current) fired.current = false;
      else click();
    },
  };
}
