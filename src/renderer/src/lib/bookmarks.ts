// Bookmarked turns, per session file. Studio-only navigation state (pi has no notion of it), kept in
// localStorage like the sidebar layout. A turn is identified by its message's timestamp: item keys are
// assigned per load and change when a session is reopened.
import { createStore, useStore } from "./store";

type Bookmarks = Record<string, number[]>;

const KEY = "pi-studio:bookmarks";
const NONE: number[] = [];

function load(): Bookmarks {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    return saved && typeof saved === "object" ? (saved as Bookmarks) : {};
  } catch {
    return {};
  }
}

const store = createStore<Bookmarks>(load());

export function useBookmarks(sessionPath: string | undefined): number[] {
  return useStore(store, (state) => (sessionPath ? (state[sessionPath] ?? NONE) : NONE));
}

export function toggleBookmark(sessionPath: string, at: number, on: boolean): void {
  store.set((state) => {
    const current = state[sessionPath] ?? NONE;
    const next = on ? [...new Set([...current, at])] : current.filter((value) => value !== at);
    const { [sessionPath]: _previous, ...rest } = state;
    return next.length ? { ...rest, [sessionPath]: next } : rest;
  });
  try {
    localStorage.setItem(KEY, JSON.stringify(store.get()));
  } catch {
    // storage unavailable: bookmarks last until the app quits
  }
}
