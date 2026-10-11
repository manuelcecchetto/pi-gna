import { useEffect, useState } from "react";

const SHOW_MS = 1200;

/**
 * Flashes the app's zoom (Cmd +/-, Cmd 0) as a percentage for a moment after it changes. Sits in the chat column,
 * not over the whole window: the browser pane is a native view that would cover it. A zoom change resizes the
 * viewport in CSS px, so "resize" is the signal (main.tsx); a plain window resize leaves the factor alone and shows nothing.
 */
export function ZoomCue() {
  const [zoom, setZoom] = useState<number>();
  useEffect(() => {
    let last = window.studio.zoomFactor();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      const factor = window.studio.zoomFactor();
      if (factor === last) return;
      last = factor;
      setZoom(Math.round(factor * 100));
      clearTimeout(timer);
      timer = setTimeout(() => setZoom(undefined), SHOW_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timer);
    };
  }, []);
  if (zoom === undefined) return null;
  return (
    <div role="status" className="pointer-events-none absolute top-[calc(64px*var(--unzoom))] left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-raised px-3 py-1.5 font-mono text-[13px] text-fg tabular-nums shadow-lg">
      {zoom}%
    </div>
  );
}
