// ⌘P, apart from the browser pane: App and the command palette call it before the pane's chunk has loaded (lib/deferred.ts).
import { showBrowser, store } from "../state/app";

/** Set by ⌘P while the start tab that should show the file finder is still being opened. */
let pending = false;
/** Tells a start tab that is already showing to switch to the file finder. */
export const FILES_EVENT = "pigna:start-files";

/** ⌘P: the file finder of the active start tab, or of a new one. */
export function showFileFinder(): void {
  const { browser: state, pane, active } = store.get();
  if (!active) return;
  const tab = state.tabs.find((entry) => entry.id === state.activeId);
  pending = true;
  if (tab?.start && pane.open) window.dispatchEvent(new Event(FILES_EVENT));
  else if (!tab?.start) window.studio.browser.newTab();
  showBrowser();
}

/** Whether ⌘P asked for the file finder since the last call; a start tab takes it when it mounts or hears FILES_EVENT. */
export function takeFilesPending(): boolean {
  const was = pending;
  pending = false;
  return was;
}
