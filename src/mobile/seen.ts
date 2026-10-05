// Which finished runs this phone has already opened (SeenMarks in chat-list.ts), kept in the page's storage:
// unread is per device, so another client's reading never clears a mark here.
import { useSyncExternalStore } from "react";
import type { SeenMarks } from "./chat-list";

const KEY = "pigna:mobile-seen";
const listeners = new Set<() => void>();
let cache: SeenMarks | undefined;

function read(): SeenMarks {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    cache = parsed && typeof parsed === "object" ? (parsed as SeenMarks) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function markSeen(handle: string | undefined, at: number | undefined): void {
  if (!handle || at === undefined || (read()[handle] ?? -1) >= at) return;
  cache = { ...read(), [handle]: at };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Private mode: the marks last as long as the page.
  }
  listeners.forEach((notify) => notify());
}

export function useSeen(): SeenMarks {
  return useSyncExternalStore(
    (notify) => (listeners.add(notify), () => void listeners.delete(notify)),
    read,
  );
}
