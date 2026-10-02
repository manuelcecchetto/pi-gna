// Tiny external store: synchronous state for actions, one rAF-batched notification per frame
// for React (useSyncExternalStore), so a burst of streaming deltas renders once.
import { useSyncExternalStore } from "react";

export interface Store<T> {
  /** Latest state; use in actions. */
  get(): T;
  set(update: (state: T) => T): void;
  subscribe(listener: () => void): () => void;
  /** State as of the last notification; what components render. */
  snapshot(): T;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  let committed = initial;
  let scheduled = false;
  const listeners = new Set<() => void>();
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (!scheduled) return;
    scheduled = false;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    committed = state;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    snapshot: () => committed,
    set(update) {
      const next = update(state);
      if (next === state) return;
      state = next;
      if (!scheduled) {
        scheduled = true;
        frame = requestAnimationFrame(flush);
        // rAF pauses while the window is occluded; keep state flowing at a low rate anyway.
        timer = setTimeout(flush, 250);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Select a stable slice; selectors must return existing references, not new objects. */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.snapshot()));
}
