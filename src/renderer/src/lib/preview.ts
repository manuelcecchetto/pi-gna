// Renderer side of file previews: opening a path in a preview tab, the Open file dialog, display helpers.
import { File, FileCode, FileImage, FileText, Film, Music, type LucideIcon } from "lucide-react";
import type { PreviewKind, PreviewOpenOptions } from "../../../shared/preview";
import { setPane, store, toast } from "../state/app";
import { resolveFilePath } from "./preview-path";

/** Opens a local file in a preview tab; the active chat's project is the root so relative links work. */
export async function openPreviewPath(path: string, options: PreviewOpenOptions = {}): Promise<void> {
  const state = store.get();
  const cwd = state.active ? state.sessions[state.active]?.cwd : undefined;
  const resolved = resolveFilePath(path, cwd, window.studio.homeDir);
  if (!resolved) return toast("Could not resolve the file path", "error");
  setPane({ open: true });
  try {
    await window.studio.browser.preview(resolved, { root: cwd, ...options });
  } catch (error) {
    toast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Could not open the file", "error");
  }
}

/**
 * Click handler for a file path in the transcript: plain click previews, cmd/ctrl-click opens a new tab.
 * Ignored while text is being selected so the path stays copyable.
 */
export function previewClick(path: string, line?: number) {
  return (event: { metaKey: boolean; ctrlKey: boolean; stopPropagation: () => void }): void => {
    // The phone shares the transcript but has no preview tabs.
    if (!window.studio?.browser?.preview || window.getSelection()?.toString()) return;
    event.stopPropagation();
    void openPreviewPath(path, { line, newTab: event.metaKey || event.ctrlKey });
  };
}

/** The native file dialog, then a preview of the choice. */
export async function openFileDialog(): Promise<void> {
  const picked = (await window.studio.pickAttachments("files")).find((entry) => !entry.isDir);
  if (picked) await openPreviewPath(picked.path);
}

/** `/Users/me/x` -> `~/x`. */
export function shortenHome(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function iconForKind(kind: PreviewKind): LucideIcon {
  switch (kind) {
    case "image":
      return FileImage;
    case "code":
    case "json":
    case "html":
      return FileCode;
    case "markdown":
    case "text":
    case "docx":
    case "table":
    case "pdf":
      return FileText;
    case "video":
      return Film;
    case "audio":
      return Music;
    default:
      return File;
  }
}
