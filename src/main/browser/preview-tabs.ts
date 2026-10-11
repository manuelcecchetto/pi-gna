// Pure parts of preview tabs: which tab a file opens in, which root it is served from, and the file watcher.
import { watch, type FSWatcher } from "node:fs";
import { dirname, basename, relative, resolve, sep } from "node:path";
import { parsePreviewUrl, type PreviewMode } from "../../shared/preview";

export const RELOAD_DEBOUNCE_MS = 150;

/** The tab already previewing `path`, if any; a preview of the same file is reused unless a new tab is asked for. */
export function reusableTab(tabs: { id: string; path?: string }[], path: string): string | undefined {
  return tabs.find((tab) => tab.path === path)?.id;
}

/**
 * Whether opening a file again in the tab already previewing it has to load the page again: another view, a line to jump
 * to (the viewer reads it from the URL when it starts), or a crashed page. Otherwise the tab is just shown, keeping its
 * scroll position and, for a long document, a layout that took seconds.
 */
export function needsReload(shown: PreviewMode, wanted: PreviewMode, line?: number, crashed = false): boolean {
  return crashed || shown !== wanted || (line !== undefined && Number.isInteger(line) && line > 0);
}

/**
 * Whether two preview URLs show the same page: the same file of the same token in the same view. The line hash and the
 * viewer's own state do not count, so the agent's copy of a preview is loaded again only when the tab shows another
 * file or view. Any other URL is the same page only when it is equal.
 */
export function samePreviewPage(a: string, b: string): boolean {
  const left = parsePreviewUrl(a);
  const right = parsePreviewUrl(b);
  if (!left || !right) return a === b;
  const view = (parsed: { view?: string }) => (parsed.view === "raw" || parsed.view === "source" ? "raw" : "rendered");
  return left.token === right.token && left.relative === right.relative && view(left) === view(right);
}

/** Root a file is served from: the project when the file lies inside it, otherwise the file's own directory. Both realpathed. */
export function previewRoot(file: string, project?: string): string {
  if (!project) return dirname(file);
  const base = resolve(project);
  return resolve(file).startsWith(base.endsWith(sep) ? base : base + sep) ? project : dirname(file);
}

/** Path of `file` below `root`, with forward slashes. */
export function relativeTo(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** Calls `fn` once after `delay` ms without further calls. */
export function debounced(fn: () => void, delay = RELOAD_DEBOUNCE_MS): { (): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
  call.cancel = () => clearTimeout(timer);
  return call;
}

/**
 * Watch one file for changes. The parent directory is watched and filtered by name, because editors that save through
 * a temporary file and a rename replace the inode and a watch on the file itself would go silent.
 */
export function watchFile(file: string, onChange: () => void, delay = RELOAD_DEBOUNCE_MS): () => void {
  const name = basename(file);
  const fire = debounced(onChange, delay);
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(file), (_event, changed) => {
      if (!changed || changed === name) fire();
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    // An unwatchable directory only costs live reload.
  }
  return () => {
    fire.cancel();
    watcher?.close();
  };
}

/** Files the OS would run rather than open: never handed to "Open with default app". */
const RUNNABLE = /\.(app|command|sh|bash|zsh|exe|bat|cmd|pkg|dmg|scpt|workflow|jar|terminal)$/i;
export function isRunnable(path: string, mode: number): boolean {
  return RUNNABLE.test(path) || (mode & 0o111) !== 0;
}
