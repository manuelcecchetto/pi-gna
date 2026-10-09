import { type ComponentType, createElement, type ReactElement, useEffect, useSyncExternalStore } from "react";

/** A component whose code is a chunk of its own, loaded on first use (`deferred`). */
export type Deferred<P> = ((props: P) => ReactElement | null) & { preload: () => Promise<void> };

const preloads: (() => Promise<void>)[] = [];

let painted: Promise<void> | undefined;
/**
 * Resolves once the window has painted content, or after `fallback` ms if it does not (a window that starts hidden).
 * Chunks load after it: before it the window is idle while it waits on its first images, and chunk requests to
 * main's app:// handler would delay those (and so the first paint) by tens of ms.
 */
export function firstPaint(fallback = 3000): Promise<void> {
  return (painted ??= new Promise<void>((done) => {
    if (typeof PerformanceObserver !== "function" || !PerformanceObserver.supportedEntryTypes?.includes("paint")) return done();
    const finish = () => {
      observer.disconnect();
      clearTimeout(timer);
      done();
    };
    const observer = new PerformanceObserver((list) => {
      if (list.getEntriesByName("first-contentful-paint").length) finish();
    });
    const timer = setTimeout(finish, fallback);
    observer.observe({ type: "paint", buffered: true });
  }));
}

/**
 * A component that is not in the startup bundle: `load` is a dynamic import, so the bundler moves the component, and
 * what only it imports, into a chunk of its own and the window parses less before its first paint. It renders nothing
 * until the chunk has loaded (it starts loading when first rendered, after the first paint), then renders as a static import would. There is
 * no Suspense: once loaded, opening it shows it in the same frame instead of a fallback first.
 */
export function deferred<P extends object>(load: () => Promise<ComponentType<P>>): Deferred<P> {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const preload = (): Promise<void> =>
    (loading ??= load().then(
      (component) => {
        loaded = component;
        for (const listener of listeners) listener();
      },
      (error: unknown) => {
        loading = undefined; // the next use tries again
        console.error("a deferred chunk failed to load", error);
      },
    ));
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const current = () => loaded;
  function Deferred(props: P): ReactElement | null {
    const Component = useSyncExternalStore(subscribe, current, current);
    useEffect(() => {
      if (!Component) void firstPaint().then(preload);
    }, [Component]);
    return Component ? createElement(Component, props) : null;
  }
  preloads.push(preload);
  return Object.assign(Deferred, { preload });
}

/**
 * Loads every deferred chunk once the window is idle after its first paint (at the latest `timeout` ms after it), so the
 * pages are in memory before anyone opens one, and before a rebuild of out/ could replace the files this window's
 * build points at. Returns a cancel.
 */
export function preloadDeferred(timeout = 2000): () => void {
  const all = () => {
    for (const preload of preloads) void preload();
  };
  let cancelled = false;
  let stop = () => {};
  void firstPaint().then(() => {
    if (cancelled) return;
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(all, 0);
      stop = () => clearTimeout(timer);
    } else {
      const id = requestIdleCallback(all, { timeout });
      stop = () => cancelIdleCallback(id);
    }
  });
  return () => {
    cancelled = true;
    stop();
  };
}
