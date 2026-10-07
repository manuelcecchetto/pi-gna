// Full-screen image: pinch to zoom, drag to pan once zoomed, double tap to toggle, tap outside or X to close. The image is a
// plain <img>, so iOS's own long-press menu (Save to Photos, Copy) works on it.
// The grid's single track is the full box: an auto track would grow to a tall image's natural height, so max-h-full would
// not bind and only its top would show.
import { X } from "../renderer/src/components/icons";
import { useRef, useState } from "react";
import { closeLightbox, useLightbox } from "./chat-ui";
import { clampView, distance, doubleTap, FIT, midpoint, type View, zoomAt } from "./pinch";

export function Lightbox() {
  const src = useLightbox();
  if (!src) return null;
  return <Viewer key={src.slice(0, 64) + src.length} src={src} />;
}

function Viewer({ src }: { src: string }) {
  const [view, setView] = useState<View>(FIT);
  const box = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** The gesture in progress: the view and finger geometry it began with. */
  const gesture = useRef<{ view: View; distance: number; mid: { x: number; y: number } } | null>(null);
  const lastTap = useRef(0);
  const moved = useRef(false);

  const center = () => {
    const r = box.current?.getBoundingClientRect();
    return { x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 };
  };
  const size = () => ({ w: image.current?.offsetWidth ?? 0, h: image.current?.offsetHeight ?? 0 });
  const begin = (current: View) => {
    const points = [...pointers.current.values()];
    const mid = points.length > 1 ? midpoint(points[0]!, points[1]!) : points[0]!;
    gesture.current = { view: current, distance: points.length > 1 ? distance(points[0]!, points[1]!) : 0, mid };
  };

  const down = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved.current = false;
    begin(view);
  };
  const move = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    const points = [...pointers.current.values()];
    const c = center();
    if (points.length > 1 && start.distance > 0) {
      const mid = midpoint(points[0]!, points[1]!);
      const scaled = zoomAt(start.view, start.view.scale * (distance(points[0]!, points[1]!) / start.distance), { x: start.mid.x - c.x, y: start.mid.y - c.y });
      moved.current = true;
      setView(clampView({ ...scaled, x: scaled.x + (mid.x - start.mid.x), y: scaled.y + (mid.y - start.mid.y) }, size()));
    } else if (start.view.scale > 1 && points[0]) {
      if (Math.abs(points[0].x - start.mid.x) + Math.abs(points[0].y - start.mid.y) > 4) moved.current = true;
      setView(clampView({ ...start.view, x: start.view.x + points[0].x - start.mid.x, y: start.view.y + points[0].y - start.mid.y }, size()));
    }
  };
  const up = (event: React.PointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size) return begin(view); // a finger stays: carry on from the current view
    gesture.current = null;
    if (moved.current) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      const c = center();
      setView((v) => doubleTap(v, { x: event.clientX - c.x, y: event.clientY - c.y }));
      lastTap.current = 0;
    } else lastTap.current = now;
  };

  return (
    <div
      ref={box}
      data-testid="lightbox"
      className="fixed inset-0 z-50 grid grid-cols-[100%] grid-rows-[100%] place-items-center overflow-hidden bg-black/90"
      style={{ touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={(event) => event.target === event.currentTarget && closeLightbox()}
    >
      <img
        ref={image}
        alt=""
        src={src}
        draggable={false}
        className="max-h-full max-w-full object-contain"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: gesture.current ? "none" : "transform 120ms ease-out" }}
      />
      <button
        type="button"
        aria-label="Close image"
        onClick={closeLightbox}
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white"
      >
        <X size={20} />
      </button>
    </div>
  );
}
