import { describe, expect, it } from "vitest";
import type { BrowserTab } from "../shared/browser";
import { previewFor } from "../shared/preview";
import { blockForLine, drawnOnPhone, drawnPreview, linesBefore, prettyJson } from "./file-data";

describe("the phone's File screen", () => {
  it("draws text kinds and images itself and streams the rest", () => {
    for (const path of ["/p/README.md", "/p/a.ts", "/p/notes.txt", "/p/data.json", "/p/t.csv", "/p/shot.png", "/p/LICENSE", "/p/.env"]) expect(drawnOnPhone(path)).toBe(true);
    for (const path of ["/p/doc.pdf", "/p/deck.pptx", "/p/page.html", "/p/clip.mp4"]) expect(drawnOnPhone(path)).toBe(false);
  });

  it("finds the block a line falls in", () => {
    expect(blockForLine([1, 3, 8], 1)).toBe(0);
    expect(blockForLine([1, 3, 8], 5)).toBe(1);
    expect(blockForLine([1, 3, 8], 40)).toBe(2);
    expect(blockForLine([4, 9], 2)).toBe(0);
  });

  it("counts the front matter's lines and pretty-prints JSON it can parse", () => {
    const text = "---\ntitle: x\n---\n# Body";
    expect(linesBefore(text, "# Body")).toBe(3);
    expect(linesBefore("# Body", "# Body")).toBe(0);
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("{ // jsonc")).toBe("{ // jsonc");
  });
});

describe("preview tabs on the Browser screen", () => {
  const tab = (path: string | undefined, url = "pigna-file://t/a", agent: string | null = "chat1"): BrowserTab =>
    ({ id: "t1", url, title: "", loading: false, canGoBack: false, canGoForward: false, agent: agent ?? undefined, surface: "pane", preview: path ? { ...previewFor(path), rev: 2 } : undefined }) as BrowserTab;

  it("draws a text or image preview from the chat's folders, at the tab's line", () => {
    expect(drawnPreview(tab("/p/README.md", "pigna-file://t/README.md#L12"))).toEqual({ chat: "chat1", path: "/p/README.md", rev: 2, line: 12 });
    expect(drawnPreview(tab("/p/shot.png"), "chat2")).toEqual({ chat: "chat2", path: "/p/shot.png", rev: 2, line: undefined });
  });

  it("streams web pages, kinds the phone cannot draw, and previews no chat owns", () => {
    expect(drawnPreview(tab(undefined, "https://site.test/"))).toBeUndefined();
    expect(drawnPreview(tab("/p/report.pdf"))).toBeUndefined();
    expect(drawnPreview(tab("/p/README.md", "pigna-file://t/README.md", null))).toBeUndefined();
  });
});
