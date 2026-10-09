// Browser tab icons by key: the browser state names each tab's icon by a content key, and the icon's data URL is asked
// for once per key and kept, by the desktop pane and the phone's browser alike (each with its own way to ask the host).
import { useEffect, useSyncExternalStore } from "react";

const LIMIT = 200;
const known = new Map<string, string>();
const asked = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();

/** The data URL behind `key`, asking `load` at most once at a time per key. A miss is not kept: the key may come back. */
export function faviconFor(key: string, load: (key: string) => Promise<string | null>): Promise<string | null> {
  const have = known.get(key);
  if (have) return Promise.resolve(have);
  let request = asked.get(key);
  if (!request) {
    request = load(key)
      .catch(() => null)
      .then((url) => {
        asked.delete(key);
        if (url) {
          known.set(key, url);
          if (known.size > LIMIT) known.delete(known.keys().next().value as string);
          for (const listener of listeners) listener();
        }
        return url;
      });
    asked.set(key, request);
  }
  return request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A tab icon's data URL by its key; undefined without a key and until it has loaded. */
export function useFavicon(key: string | undefined, load: (key: string) => Promise<string | null>): string | undefined {
  const url = useSyncExternalStore(subscribe, () => (key ? known.get(key) : undefined));
  useEffect(() => {
    if (key && !known.has(key)) void faviconFor(key, load);
  }, [key]);
  return url;
}
