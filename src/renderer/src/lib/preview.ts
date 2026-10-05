// Renderer side of file previews: opening a path in a preview tab, the Open file dialog, display helpers.
import { File, FileCode, FileImage, FileText, Film, Music, type LucideIcon } from "lucide-react";
import { kindFor, parseLinkTarget, type PreviewKind, type PreviewOpenOptions } from "../../../shared/preview";
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

const activeCwd = () => {
  const state = store.get();
  return state.active ? state.sessions[state.active]?.cwd : undefined;
};

/**
 * Settles the file links of a rendered answer (docs/FILE_PREVIEW.md, Chat links): links to missing files
 * become plain text with a tooltip, path-like inline code that exists becomes a link. Where there is no
 * preview (the phone) every file link becomes plain text.
 */
export async function resolveFileLinks(root: HTMLElement | null): Promise<void> {
  if (!root) return;
  const links = [...root.querySelectorAll<HTMLElement>("[data-file]:not([data-checked])")];
  const codes = [...root.querySelectorAll<HTMLElement>("code[data-path]:not([data-checked])")].filter((el) => !el.closest("[data-file], a"));
  const api = window.studio?.browser;
  const cwd = activeCwd();
  const downgrade = (el: HTMLElement, reason: string) => {
    el.removeAttribute("data-file");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.classList.add("file-missing");
    el.title = reason;
  };
  if (!api?.resolvePreviewTargets) {
    for (const el of links) downgrade(el, el.dataset.file ?? "");
    return;
  }
  if (!cwd || links.length + codes.length === 0) return;
  const raw = (el: HTMLElement) => el.dataset.file ?? el.dataset.path ?? "";
  const targets = [...new Set([...links, ...codes].map(raw))];
  let resolved: (string | null)[];
  try {
    resolved = await api.resolvePreviewTargets(cwd, targets);
  } catch {
    return;
  }
  if (!root.isConnected) return;
  const found = new Map(targets.map((target, index) => [target, resolved[index] ?? null]));
  for (const el of [...links, ...codes]) {
    el.dataset.checked = "1";
    const path = found.get(raw(el));
    if (!path) {
      if (el.dataset.file) downgrade(el, `File not found: ${raw(el)}`);
      continue;
    }
    const line = parseLinkTarget(raw(el), cwd, window.studio.homeDir)?.line;
    el.dataset.resolved = path;
    el.title = `${shortenHome(path, window.studio.homeDir)}${line ? `:${line}` : ""} (⌘-click: new tab)`;
    if (!el.dataset.file) {
      el.dataset.file = raw(el);
      el.dataset.kind = kindFor(path);
      el.classList.add("file-link");
      el.setAttribute("role", "link");
      el.tabIndex = 0;
    }
  }
}

/**
 * Swaps the embedded images of a rendered answer (`![alt](path)`, after resolveFileLinks kept the ones that exist) for
 * the image itself. One that cannot be read (too large, not an image) stays a file link.
 */
export async function loadChatImages(root: HTMLElement | null): Promise<void> {
  const api = window.studio?.browser;
  const cwd = activeCwd();
  if (!root || !cwd || !api?.readPreviewImage) return;
  const pending = [...root.querySelectorAll<HTMLElement>("[data-image][data-resolved]:not([data-loaded])")];
  await Promise.all(
    pending.map(async (el) => {
      el.dataset.loaded = "1";
      const image = await api.readPreviewImage(cwd, el.dataset.image ?? "").catch(() => null);
      if (!image || !el.isConnected) return;
      const img = document.createElement("img");
      img.alt = el.textContent ?? "";
      img.decoding = "async";
      img.src = `data:${image.mimeType};base64,${image.data}`;
      // Now an image, not a file link: a click opens the lightbox (Markdown.tsx).
      el.classList.remove("file-link");
      for (const name of ["role", "tabindex", "data-file", "title"]) el.removeAttribute(name);
      el.replaceChildren(img);
    }),
  );
}

/** Click or Enter on a `[data-file]` element of a rendered answer: preview it (cmd/ctrl: new tab). */
export function openFileLink(el: HTMLElement, event: { metaKey: boolean; ctrlKey: boolean }): void {
  if (!window.studio?.browser?.preview || window.getSelection()?.toString()) return;
  const raw = el.dataset.file ?? "";
  const target = parseLinkTarget(raw, activeCwd(), window.studio.homeDir);
  const path = el.dataset.resolved ?? target?.path;
  if (!path) return toast("Could not resolve the file path", "error");
  void openPreviewPath(path, { line: target?.line, newTab: event.metaKey || event.ctrlKey });
}
