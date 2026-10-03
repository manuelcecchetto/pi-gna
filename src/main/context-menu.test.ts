import { describe, expect, it, vi } from "vitest";
import { contextMenuTemplate, type MenuContents, type MenuParams, type MenuSurface } from "./context-menu";

const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn(), write: vi.fn(async () => undefined) },
  ClipboardItem: class {
    constructor(readonly items: Record<string, Blob>) {}
  },
  shell: { openExternal: vi.fn(async () => undefined) },
  Menu: {},
}));
vi.mock("electron", () => electron);

const flags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true, canDelete: false, canEditRichly: false };
const params = (patch: Partial<MenuParams> = {}): MenuParams => ({
  x: 40,
  y: 60,
  linkURL: "",
  srcURL: "",
  mediaType: "none",
  hasImageContents: false,
  selectionText: "",
  isEditable: false,
  editFlags: flags,
  misspelledWord: "",
  dictionarySuggestions: [],
  ...patch,
});
const contents = () => {
  const fake = {
    copy: vi.fn(),
    cut: vi.fn(),
    paste: vi.fn(),
    pasteAndMatchStyle: vi.fn(),
    selectAll: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    replaceMisspelling: vi.fn(),
    copyImageAt: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(async (): Promise<unknown> => "data:image/png;base64,iVBORw0KGgo="),
    downloadURL: vi.fn(),
    showDefinitionForSelection: vi.fn(),
    reload: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    inspectElement: vi.fn(),
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
  };
  return fake as typeof fake & MenuContents;
};
const surface = (page: boolean): MenuSurface => ({ page, openTab: vi.fn() });
const labels = (template: ReturnType<typeof contextMenuTemplate>) =>
  template.map((item) => (item.type === "separator" ? "—" : `${item.label}${item.enabled === false ? " (off)" : ""}`));
const click = (template: ReturnType<typeof contextMenuTemplate>, label: string) => {
  const item = template.find((other) => other.label === label);
  if (!item?.click) throw new Error(`no ${label} in ${labels(template).join(", ")}`);
  (item.click as () => void)();
};

describe("contextMenuTemplate", () => {
  it("copies and saves an app window image (a data: URL in a lightbox button)", () => {
    const wc = contents();
    const src = "data:image/png;base64,AAAA";
    const template = contextMenuTemplate(params({ mediaType: "image", srcURL: src, hasImageContents: true }), wc, surface(false));
    expect(labels(template)).toEqual(["Copy Image", "Save Image As…"]);
    click(template, "Copy Image");
    expect(wc.copyImageAt).toHaveBeenCalledWith(40, 60);
    click(template, "Save Image As…");
    expect(wc.downloadURL).toHaveBeenCalledWith(src);
  });

  it("copies an SVG image as a PNG drawn in the page, or Chromium's copy when it cannot be drawn", async () => {
    const wc = contents();
    const svg = params({ mediaType: "image", srcURL: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E", hasImageContents: true });
    click(contextMenuTemplate(svg, wc, surface(false)), "Copy Image");
    await vi.waitFor(() => expect(electron.clipboard.write).toHaveBeenCalledTimes(1));
    const [[item]] = electron.clipboard.write.mock.calls[0] as unknown as [[{ items: Record<string, Blob> }]];
    expect(Object.keys(item.items)).toEqual(["image/png"]);
    expect(Buffer.from(await new Response(item.items["image/png"]).arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(wc.copyImageAt).not.toHaveBeenCalled();

    wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(null); // a cross-origin SVG taints the canvas
    click(contextMenuTemplate({ ...svg, srcURL: "https://cdn.example.com/logo.svg?v=2" }, wc, surface(true)), "Copy Image");
    await vi.waitFor(() => expect(wc.copyImageAt).toHaveBeenCalledWith(40, 60));
    expect(electron.clipboard.write).toHaveBeenCalledTimes(1);
  });

  it("offers a page's linked image in new tabs, with its addresses, and Inspect Element", () => {
    const wc = contents();
    const pane = surface(true);
    const template = contextMenuTemplate(
      params({ linkURL: "https://example.com/post", mediaType: "image", srcURL: "https://example.com/cat.png", hasImageContents: false }),
      wc,
      pane,
    );
    expect(labels(template)).toEqual([
      "Open Link in New Tab",
      "Open Link in Default Browser",
      "—",
      "Copy Link",
      "—",
      "Copy Image (off)", // not loaded yet
      "Copy Image Address",
      "Save Image As…",
      "Open Image in New Tab",
      "—",
      "Inspect Element",
    ]);
    click(template, "Open Image in New Tab");
    expect(pane.openTab).toHaveBeenCalledWith("https://example.com/cat.png");
    click(template, "Copy Image Address");
    expect(electron.clipboard.writeText).toHaveBeenLastCalledWith("https://example.com/cat.png");
    click(template, "Open Link in Default Browser");
    expect(electron.shell.openExternal).toHaveBeenLastCalledWith("https://example.com/post");
    click(template, "Inspect Element");
    expect(wc.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    expect(wc.inspectElement).toHaveBeenCalledWith(40, 60);
  });

  it("opens app window links outside or in the browser pane, and only copies other schemes", () => {
    const app = surface(false);
    const template = contextMenuTemplate(params({ linkURL: "https://pi.dev/docs" }), contents(), app);
    expect(labels(template)).toEqual(["Open Link", "Open Link in pi-gna Browser", "—", "Copy Link"]);
    click(template, "Open Link in pi-gna Browser");
    expect(app.openTab).toHaveBeenCalledWith("https://pi.dev/docs");
    expect(labels(contextMenuTemplate(params({ linkURL: "mailto:me@example.com" }), contents(), app))).toEqual(["Open Link", "—", "Copy Link"]);
    expect(labels(contextMenuTemplate(params({ linkURL: "javascript:alert(1)" }), contents(), app))).toEqual(["Copy Link"]);
  });

  it("copies, looks up and searches selected text", () => {
    const wc = contents();
    const template = contextMenuTemplate(params({ selectionText: "  the   mano a pigna gesture, explained \n" }), wc, surface(false));
    const lookUp = process.platform === "darwin" ? ["Look Up “the mano a pigna gesture…”"] : [];
    expect(labels(template)).toEqual(["Copy", "—", ...lookUp, "Search Google for “the mano a pigna gesture…”"]);
    click(template, "Copy");
    expect(wc.copy).toHaveBeenCalled();
    click(template, "Search Google for “the mano a pigna gesture…”");
    expect(electron.shell.openExternal).toHaveBeenLastCalledWith("https://www.google.com/search?q=the%20mano%20a%20pigna%20gesture%2C%20explained");
  });

  it("edits fields, with spelling guesses and Paste and Match Style only where they apply", () => {
    const wc = contents();
    const field = params({ isEditable: true, selectionText: "teh", misspelledWord: "teh", dictionarySuggestions: ["the", "ten"], editFlags: { ...flags, canCopy: true } });
    const template = contextMenuTemplate(field, wc, surface(false));
    expect(labels(template)).toEqual(["the", "ten", "—", "Undo (off)", "Redo (off)", "—", "Cut (off)", "Copy", "Paste", "Select All"]);
    click(template, "the");
    expect(wc.replaceMisspelling).toHaveBeenCalledWith("the");
    click(template, "Paste");
    expect(wc.paste).toHaveBeenCalled();
    const rich = contextMenuTemplate(params({ isEditable: true, editFlags: { ...flags, canEditRichly: true } }), wc, surface(false));
    expect(labels(rich)).toContain("Paste and Match Style");
  });

  it("shows nothing for a plain spot in the app window, and navigation on a page", () => {
    expect(contextMenuTemplate(params(), contents(), surface(false))).toEqual([]);
    const wc = contents();
    const template = contextMenuTemplate(params(), wc, surface(true));
    expect(labels(template)).toEqual(["Back", "Forward (off)", "Reload", "—", "Inspect Element"]);
    click(template, "Back");
    expect(wc.navigationHistory.goBack).toHaveBeenCalled();
  });
});
