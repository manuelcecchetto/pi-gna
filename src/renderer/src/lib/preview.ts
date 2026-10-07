// Renderer side of file previews: opening a path in a preview tab, the Open file dialog, display helpers.
import { File, FileCode, FileImage, FileSpreadsheet, FileText, Film, Music, Presentation, type IconComponent } from "../components/icons";
import type { Board } from "../../../shared/board";
import { kindFor, parseLinkTarget, type PreviewKind, type PreviewOpenOptions } from "../../../shared/preview";
import { showBrowser, store, toast } from "../state/app";
import type { ChatLinks } from "./chat-ui";
import { resolveFilePath } from "./preview-path";

/** Opens a local file in a preview tab; the active chat's project is the root so relative links work. */
export async function openPreviewPath(path: string, options: PreviewOpenOptions = {}): Promise<void> {
  const state = store.get();
  const cwd = state.active ? state.sessions[state.active]?.cwd : undefined;
  const resolved = resolveFilePath(path, cwd, window.studio.homeDir);
  if (!resolved) return toast("Could not resolve the file path", "error");
  showBrowser();
  try {
    await window.studio.browser.preview(resolved, { root: cwd, ...options });
  } catch (error) {
    toast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Could not open the file", "error");
  }
}

/** The desktop window's chat links: previews and cards in the browser pane beside the chat. */
export const desktopLinks: ChatLinks = {
  cwd: () => activeCwd(),
  resolve(targets) {
    const cwd = activeCwd();
    return cwd ? window.studio.browser.resolvePreviewTargets(cwd, targets) : Promise.resolve(targets.map(() => null));
  },
  image(target) {
    const cwd = activeCwd();
    return cwd ? window.studio.browser.readPreviewImage(cwd, target) : Promise.resolve(null);
  },
  openFile: (path, options) => void openPreviewPath(path, options),
  openCard(card) {
    showBrowser();
    void window.studio.browser.card(card.id).catch(() => toast("Could not open the card", "error"));
  },
};

/**
 * Click handler for a file path in the transcript: plain click previews, cmd/ctrl-click opens a new tab.
 * Ignored while text is being selected so the path stays copyable, and where links cannot open.
 */
export function previewClick(links: ChatLinks | undefined, path: string, line?: number) {
  return (event: { metaKey: boolean; ctrlKey: boolean; stopPropagation: () => void }): void => {
    if (!links || window.getSelection()?.toString()) return;
    event.stopPropagation();
    links.openFile(path, { line, newTab: event.metaKey || event.ctrlKey });
  };
}

/** The native file dialog, then a preview of the choice (in the start tab `into`, when given). */
export async function openFileDialog(into?: string): Promise<void> {
  const picked = (await window.studio.pickAttachments("files")).find((entry) => !entry.isDir);
  if (picked) await openPreviewPath(picked.path, { into });
}

/** `/Users/me/x` -> `~/x`. */
export function shortenHome(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function iconForKind(kind: PreviewKind): IconComponent {
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
    case "pdf":
      return FileText;
    case "table":
    case "xlsx":
      return FileSpreadsheet;
    case "pptx":
      return Presentation;
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
 * become plain text with a tooltip, path-like inline code that exists becomes a link. Where links cannot
 * open (`api` absent) every file link becomes plain text.
 */
export async function resolveFileLinks(root: HTMLElement | null, api: ChatLinks | undefined, homeDir: string): Promise<void> {
  if (!root) return;
  const links = [...root.querySelectorAll<HTMLElement>("[data-file]:not([data-checked])")];
  const codes = [...root.querySelectorAll<HTMLElement>("code[data-path]:not([data-checked])")].filter((el) => !el.closest("[data-file], a"));
  const cwd = api?.cwd();
  const downgrade = (el: HTMLElement, reason: string) => {
    el.removeAttribute("data-file");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.classList.add("file-missing");
    el.title = reason;
  };
  if (!api) {
    for (const el of links) downgrade(el, el.dataset.file ?? "");
    return;
  }
  if (!cwd || links.length + codes.length === 0) return;
  const raw = (el: HTMLElement) => el.dataset.file ?? el.dataset.path ?? "";
  const targets = [...new Set([...links, ...codes].map(raw))];
  let resolved: (string | null)[];
  try {
    resolved = await api.resolve(targets);
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
    const line = parseLinkTarget(raw(el), cwd, homeDir)?.line;
    el.dataset.resolved = path;
    el.title = `${shortenHome(path, homeDir)}${line ? `:${line}` : ""}${window.studio ? " (⌘-click: new tab)" : ""}`;
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
export async function loadChatImages(root: HTMLElement | null, api: ChatLinks | undefined): Promise<void> {
  if (!root || !api?.cwd()) return;
  const pending = [...root.querySelectorAll<HTMLElement>("[data-image][data-resolved]:not([data-loaded])")];
  await Promise.all(
    pending.map(async (el) => {
      el.dataset.loaded = "1";
      const image = await api.image(el.dataset.image ?? "").catch(() => null);
      if (!image || !el.isConnected) return;
      const img = document.createElement("img");
      img.alt = el.textContent ?? "";
      img.decoding = "async";
      img.src = `data:${image.mimeType};base64,${image.data}`;
      // A raw `<img>`'s authored size (markdown.ts keeps only plain numbers and percentages).
      if (el.dataset.width) img.setAttribute("width", el.dataset.width);
      if (el.dataset.height) img.setAttribute("height", el.dataset.height);
      // Now an image, not a file link: a click opens the lightbox (Markdown.tsx).
      el.classList.remove("file-link");
      for (const name of ["role", "tabindex", "data-file", "title"]) el.removeAttribute(name);
      el.replaceChildren(img);
    }),
  );
}

// Icon data URLs per origin for this window: pending requests, and the answers already in (null: the site has none).
const siteIconRequests = new Map<string, Promise<string | null>>();
const siteIconsKnown = new Map<string, string | null>();

function siteIconImage(src: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "site-icon";
  img.alt = "";
  img.decoding = "async";
  img.src = src;
  return img;
}

/**
 * Give each web link of a rendered answer a site icon at its left: the favicon once known, a globe until then and
 * when the site has none, like the ChatGPT app. Runs before paint (a layout effect), so links do not shift when the
 * slot appears; `fetch` (off while streaming) asks main for the favicons not known yet and swaps them in.
 */
export function decorateWebLinks(root: HTMLElement | null, fetch: boolean): void {
  const api = window.studio?.browser;
  if (!root || !api?.siteIcon) return;
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!/^https?:$/.test(link.protocol) || !link.hostname) continue;
    const origin = link.origin;
    let slot = link.querySelector<HTMLElement>(":scope > .site-icon");
    if (!slot) {
      const known = siteIconsKnown.get(origin);
      slot = known ? siteIconImage(known) : Object.assign(document.createElement("span"), { className: "site-icon globe" });
      slot.setAttribute("aria-hidden", "true");
      link.prepend(slot);
    }
    if (!fetch || slot.tagName === "IMG" || siteIconsKnown.has(origin)) continue;
    let request = siteIconRequests.get(origin);
    if (!request) {
      request = api.siteIcon(link.href).then((icon) => (icon ? `data:${icon.mimeType};base64,${icon.data}` : null), () => null);
      siteIconRequests.set(origin, request);
      void request.then((src) => siteIconsKnown.set(origin, src));
    }
    const placeholder = slot;
    void request.then((src) => {
      if (src && placeholder.isConnected) placeholder.replaceWith(siteIconImage(src));
    });
  }
}

/** Click or Enter on a `[data-file]` element of a rendered answer: preview it (cmd/ctrl: new tab). */
export function openFileLink(el: HTMLElement, event: { metaKey: boolean; ctrlKey: boolean }, links: ChatLinks | undefined, homeDir: string): void {
  if (!links || window.getSelection()?.toString()) return;
  const raw = el.dataset.file ?? "";
  const target = parseLinkTarget(raw, links.cwd(), homeDir);
  const path = el.dataset.resolved ?? target?.path;
  if (!path) return toast("Could not resolve the file path", "error");
  links.openFile(path, { line: target?.line, newTab: event.metaKey || event.ctrlKey });
}

/** Card links of a rendered answer (`[card x](q6ip3j)`): the card's title and column as tooltip; unknown ids read as missing. */
export function resolveCardLinks(root: HTMLElement | null, { cards }: Board): void {
  if (!root) return;
  for (const el of root.querySelectorAll<HTMLElement>("[data-card]:not([data-checked])")) {
    const id = el.dataset.card;
    const card = cards.find((entry) => entry.id === id);
    if (!card) {
      el.removeAttribute("data-card");
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
      el.classList.remove("card-link");
      el.classList.add("file-missing");
      el.title = `Card not found: ${id}`;
      continue;
    }
    el.dataset.checked = "1";
    el.title = `${card.title} · ${card.column.replace("_", " ")}`;
  }
}

/** Click or Enter on a `[data-card]` element: that card's details (on the desktop, a tab of the browser pane). */
export function openCardLink(el: HTMLElement, links: ChatLinks | undefined, { cards }: Board): void {
  if (!links || window.getSelection()?.toString()) return;
  const card = cards.find((entry) => entry.id === el.dataset.card);
  if (!card) return toast("Card not found", "error");
  links.openCard(card);
}
