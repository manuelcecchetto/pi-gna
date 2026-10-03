// Native right-click menus for the app window and the browser pane's pages: links, images, selected text and
// fields. The window's own objects (chats, projects, tabs) open DOM menus and cancel the event, so
// Chromium never asks for these there.
import { ClipboardItem, type ContextMenuParams, clipboard, Menu, type MenuItemConstructorOptions, shell, type WebContents } from "electron";

/** Where a menu opens and how its links leave it. */
export interface MenuSurface {
  /** A browser pane page (Back, Reload, Inspect Element; links open in tabs) rather than the app window. */
  page: boolean;
  /** Open a URL in a new browser pane tab, showing the pane. */
  openTab(url: string): void;
}

export type MenuParams = Pick<
  ContextMenuParams,
  "x" | "y" | "linkURL" | "srcURL" | "mediaType" | "hasImageContents" | "selectionText" | "isEditable" | "editFlags" | "misspelledWord" | "dictionarySuggestions"
>;

export type MenuContents = Pick<
  WebContents,
  | "copy"
  | "cut"
  | "paste"
  | "pasteAndMatchStyle"
  | "selectAll"
  | "undo"
  | "redo"
  | "replaceMisspelling"
  | "copyImageAt"
  | "executeJavaScriptInIsolatedWorld"
  | "downloadURL"
  | "showDefinitionForSelection"
  | "reload"
  | "isDevToolsOpened"
  | "openDevTools"
  | "inspectElement"
  | "navigationHistory"
>;

type Item = MenuItemConstructorOptions | false | undefined;

const web = (url: string) => /^https?:/i.test(url);
const external = (url: string) => {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
};

// Chromium copies an SVG image as an <img> tag only, with no pixels (Chrome too). Draw the page's own <img> into a
// PNG instead, in a world of our own; a cross-origin SVG taints the canvas, and gets Chromium's copy.
const COPY_WORLD = 4318;
const isSvg = (src: string) => /^data:image\/svg\+xml[;,]|\.svg(?:[?#]|$)/i.test(src);
const rasterize = (src: string) => `(async () => {
  const src = ${JSON.stringify(src)};
  const image = [...document.images].filter((img) => img.currentSrc === src || img.src === src).sort((a, b) => b.width - a.width)[0];
  if (!image) return null;
  await image.decode().catch(() => undefined);
  // As shown, at 2x or the SVG's own size if larger (a vector has no pixels to keep), at most 4096 px.
  const width = image.width || image.naturalWidth || 300;
  const height = image.height || image.naturalHeight || 150;
  const scale = Math.min(4096 / Math.max(width, height), Math.max(2, devicePixelRatio, image.naturalWidth / width || 0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  try { return canvas.toDataURL("image/png"); } catch { return null; }
})()`;

async function copySvg(contents: MenuContents, src: string, x: number, y: number): Promise<void> {
  const png: unknown = await contents.executeJavaScriptInIsolatedWorld(COPY_WORLD, [{ code: rasterize(src) }]).catch(() => null);
  if (typeof png !== "string" || !png.startsWith("data:image/png;base64,")) return contents.copyImageAt(x, y);
  const bytes = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
}

export function contextMenuTemplate(params: MenuParams, contents: MenuContents, surface: MenuSurface): MenuItemConstructorOptions[] {
  const sections: Item[][] = [];
  const { editFlags } = params;
  const selection = params.selectionText.trim().replace(/\s+/g, " ");
  const quoted = `“${selection.length > 24 ? `${selection.slice(0, 24)}…` : selection}”`;
  const link = params.linkURL;
  const image = params.mediaType === "image" && params.srcURL ? params.srcURL : "";

  if (params.isEditable && params.misspelledWord) {
    const guesses = params.dictionarySuggestions.slice(0, 5);
    sections.push(guesses.length ? guesses.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })) : [{ label: "No Guesses Found", enabled: false }]);
  }
  if (link) {
    sections.push(
      surface.page
        ? [web(link) && { label: "Open Link in New Tab", click: () => surface.openTab(link) }, web(link) && { label: "Open Link in Default Browser", click: () => external(link) }]
        : [/^(https?|mailto):/i.test(link) && { label: "Open Link", click: () => external(link) }, web(link) && { label: "Open Link in pi-gna Browser", click: () => surface.openTab(link) }],
      [{ label: "Copy Link", click: () => void clipboard.writeText(link) }],
    );
  }
  if (image) {
    sections.push([
      {
        label: "Copy Image",
        enabled: params.hasImageContents,
        click: () => (isSvg(image) ? void copySvg(contents, image, params.x, params.y) : contents.copyImageAt(params.x, params.y)),
      },
      /^(https?|file):/i.test(image) && { label: "Copy Image Address", click: () => void clipboard.writeText(image) },
      { label: "Save Image As…", click: () => contents.downloadURL(image) },
      surface.page && web(image) && { label: "Open Image in New Tab", click: () => surface.openTab(image) },
    ]);
  }
  if (params.isEditable) {
    sections.push(
      [
        { label: "Undo", enabled: editFlags.canUndo, click: () => contents.undo() },
        { label: "Redo", enabled: editFlags.canRedo, click: () => contents.redo() },
      ],
      [
        { label: "Cut", enabled: editFlags.canCut, click: () => contents.cut() },
        { label: "Copy", enabled: editFlags.canCopy, click: () => contents.copy() },
        { label: "Paste", enabled: editFlags.canPaste, click: () => contents.paste() },
        editFlags.canEditRichly && { label: "Paste and Match Style", enabled: editFlags.canPaste, click: () => contents.pasteAndMatchStyle() },
        { label: "Select All", enabled: editFlags.canSelectAll, click: () => contents.selectAll() },
      ],
    );
  } else if (selection) {
    const search = `https://www.google.com/search?q=${encodeURIComponent(selection)}`;
    sections.push(
      [{ label: "Copy", click: () => contents.copy() }],
      [
        process.platform === "darwin" && { label: `Look Up ${quoted}`, click: () => contents.showDefinitionForSelection() },
        { label: `Search Google for ${quoted}`, click: () => (surface.page ? surface.openTab(search) : external(search)) },
      ],
    );
  }
  if (surface.page) {
    const history = contents.navigationHistory;
    if (!sections.some((section) => section.some(Boolean))) {
      sections.push([
        { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
        { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
        { label: "Reload", click: () => contents.reload() },
      ]);
    }
    sections.push([
      {
        label: "Inspect Element",
        click: () => {
          // Docked DevTools do not fit a pane-sized view.
          if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: "detach" });
          contents.inspectElement(params.x, params.y);
        },
      },
    ]);
  }

  return sections
    .map((section) => section.filter((item): item is MenuItemConstructorOptions => Boolean(item)))
    .filter((section) => section.length)
    .flatMap((section, index) => (index ? [{ type: "separator" as const }, ...section] : section));
}

/** Show the menu for whatever was right-clicked in `contents`; nothing when it has nothing to offer. */
export function attachContextMenu(contents: WebContents, surface: MenuSurface): void {
  contents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params, contents, surface);
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
}
