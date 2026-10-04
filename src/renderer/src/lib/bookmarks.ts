// Bookmarked turns, per session file. App-only navigation state (pi has no notion of it), kept by the host so every
// client has the same ones (lib/host-ui.ts). A turn is identified by its message's timestamp: item keys are
// assigned per load and change when a session is reopened.
import { applyUi, uiStore } from "./host-ui";
import { useStore } from "./store";

const NONE: number[] = [];

export function useBookmarks(sessionPath: string | undefined): number[] {
  return useStore(uiStore, (state) => (sessionPath ? (state.bookmarks[sessionPath] ?? NONE) : NONE));
}

export function toggleBookmark(sessionPath: string, at: number, on: boolean): void {
  applyUi({ type: on ? "bookmark" : "unbookmark", session: sessionPath, at });
}
