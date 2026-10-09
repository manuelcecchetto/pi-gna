// Whether an element is near its scroller's visible area, for work that only pays off there (running inline visuals).

/** How far outside the visible area an element still counts as near: one scroller height above and below. */
export const NEAR_MARGIN = "100% 0px";

/** The nearest ancestor that scrolls, so an observer's margin reaches past its clip; null means the viewport. */
export function scrollRoot(from: Element | null): Element | null {
  for (let el = from; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

// One observer per scroller; a closed chat's scroller is dropped with it.
const observers = new WeakMap<Element, IntersectionObserver>();
let viewportObserver: IntersectionObserver | undefined;
const watchers = new WeakMap<Element, (near: boolean) => void>();

function observer(root: Element | null): IntersectionObserver {
  let found = root ? observers.get(root) : viewportObserver;
  if (!found) {
    found = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) watchers.get(target)?.(isIntersecting);
      },
      { root, rootMargin: NEAR_MARGIN },
    );
    if (root) observers.set(root, found);
    else viewportObserver = found;
  }
  return found;
}

/**
 * Calls `onChange(true)` when `target` comes within NEAR_MARGIN of its scroller's visible area and `onChange(false)` when
 * it leaves (a hidden target is never near). Without IntersectionObserver everything is near. Returns a cleanup.
 */
export function watchNear(target: Element, onChange: (near: boolean) => void): () => void {
  if (typeof IntersectionObserver !== "function") {
    onChange(true);
    return () => {};
  }
  const io = observer(scrollRoot(target.parentElement));
  watchers.set(target, onChange);
  io.observe(target);
  return () => {
    io.unobserve(target);
    watchers.delete(target);
  };
}
