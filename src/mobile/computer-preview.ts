// The phone's read-only Computer Use preview: when to ask the host for a frame, the poll that asks, and which frame to show.
import type { ComputerPreviewFrame } from "../shared/computer";
import type { Item } from "../shared/session-state";

export const PREVIEW_POLL_MS = 2000;

/**
 * Whether the chat may hold a Mac app: the current run called a computer_* tool that takes one (the host frees them
 * when the run ends). Steers belong to the run, so they do not end the scan; a page that starts inside the run (its
 * prompt not loaded) counts as maybe.
 */
export function runUsesComputer(items: readonly Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "user" && !item.steer) return false;
    if (item?.kind === "assistant" && item.message.content.some((c) => c.type === "toolCall" && c.name.startsWith("computer_") && c.name !== "computer_list_apps")) return true;
  }
  return items.length > 0;
}

/** The frame to show after an answer: a new one, the shown one while the host says it is unchanged, or none. */
export function keepFrame(shown: ComputerPreviewFrame | null, next: ComputerPreviewFrame | null): ComputerPreviewFrame | null {
  if (!next) return null;
  if (next.data) return next;
  if (shown?.id !== next.id) return null;
  return shown.app === next.app ? shown : { ...shown, app: next.app };
}

export interface PreviewPage {
  hidden(): boolean;
  onVisibility(listener: () => void): () => void;
}

export const documentPage: PreviewPage = {
  hidden: () => document.visibilityState === "hidden",
  onVisibility: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/**
 * Asks for a frame now and PREVIEW_POLL_MS after each answer: never two calls at once, none while the page is hidden,
 * and one right away when it shows again. Returns the stop function.
 */
export function pollPreview<T>(fetch: () => Promise<T>, onFrame: (frame: T) => void, page: PreviewPage = documentPage): () => void {
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    timer = undefined;
    if (stopped || busy || page.hidden()) return;
    busy = true;
    fetch()
      .then((frame) => !stopped && onFrame(frame), () => undefined)
      .finally(() => {
        busy = false;
        if (!stopped && !page.hidden()) timer = setTimeout(tick, PREVIEW_POLL_MS);
      });
  };
  const off = page.onVisibility(() => {
    if (page.hidden()) {
      clearTimeout(timer);
      timer = undefined;
    } else if (!timer) tick();
  });
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
  };
}
