import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";
import { formatStamp } from "./format";
import { markdownToHtml } from "./markdown";
import { attachmentImages, formatFileMentions, fromImageData, fromPicked, mergeAttachments, splitFileMentions } from "./attachments";
import { parsePartialJson } from "./partial-json";

describe("parsePartialJson", () => {
  it("closes an open string so streaming paths are visible early", () => {
    expect(parsePartialJson('{"path": "/repo/src/ma')).toEqual({ path: "/repo/src/ma" });
  });

  it("drops a dangling key or colon by retrying from the last comma", () => {
    expect(parsePartialJson('{"path": "/a.ts", "con')).toEqual({ path: "/a.ts" });
    expect(parsePartialJson('{"path": "/a.ts", "content": ')).toEqual({ path: "/a.ts" });
  });

  it("closes nested arrays and objects and drops half escapes", () => {
    expect(parsePartialJson('{"edits": [{"oldText": "a\\')).toEqual({ edits: [{ oldText: "a" }] });
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson('"just a string')).toBeUndefined();
  });
});

describe("parseAnsi", () => {
  it("maps 24-bit, 256 and basic colors and resets", () => {
    const spans = parseAnsi("\x1b[38;2;10;20;30mrgb\x1b[0m plain \x1b[1;31mbold red\x1b[39m bold");
    expect(spans).toEqual([
      { text: "rgb", style: { color: "rgb(10, 20, 30)" } },
      { text: " plain ", style: {} },
      { text: "bold red", style: { bold: true, color: "#ff6b6b" } },
      { text: " bold", style: { bold: true, color: undefined } },
    ]);
  });

  it("strips non-SGR escapes and OSC hyperlinks", () => {
    expect(stripAnsi("\x1b]8;;https://x.dev\x07link\x1b]8;;\x07\x1b[2K done")).toBe("link done");
  });
});

describe("file attachments", () => {
  it("formats paths Codex-style and folds them back out of a sent message", () => {
    const attachments = [
      fromPicked({ path: "/repo/src", name: "src", isDir: true }),
      fromPicked({ path: "/repo/a.ts", name: "a.ts", isDir: false }),
      fromPicked({ path: "/tmp/shot.png", name: "shot.png", isDir: false, image: { mimeType: "image/png", data: "AAAA" } }),
      fromImageData("clipboard.png", "image/png", "BBBB"), // in-memory paste: no path, image only
    ];
    const block = formatFileMentions(attachments);
    expect(block).toBe(
      "# Files mentioned by the user:\n\n## src/: /repo/src/\n## a.ts: /repo/a.ts\n## shot.png: /tmp/shot.png (image attached)",
    );
    expect(attachmentImages(attachments).map((image) => image.data)).toEqual(["AAAA", "BBBB"]);

    const [text, mentions] = splitFileMentions(`Fix the bug\n\n${block}`);
    expect(text).toBe("Fix the bug");
    expect(mentions).toEqual([
      { label: "src/", path: "/repo/src/", isDir: true, image: false },
      { label: "a.ts", path: "/repo/a.ts", isDir: false, image: false },
      { label: "shot.png", path: "/tmp/shot.png", isDir: false, image: true },
    ]);
  });

  it("leaves messages alone that merely quote the header, and dedupes re-attached paths", () => {
    // pi may append text after the block (e.g. an omitted-image note): it is kept, the block folds.
    const [kept, found] = splitFileMentions("Look\n\n# Files mentioned by the user:\n\n## a.ts: /r/a.ts\n\n[Image omitted: too large]");
    expect(kept).toBe("Look\n\n[Image omitted: too large]");
    expect(found.map((m) => m.path)).toEqual(["/r/a.ts"]);
    const quoted = "# Files mentioned by the user:\nplease explain this header";
    expect(splitFileMentions(quoted)).toEqual([quoted, []]);
    const first = [fromPicked({ path: "/repo/a.ts", name: "a.ts", isDir: false })];
    expect(mergeAttachments(first, [fromPicked({ path: "/repo/a.ts", name: "a.ts", isDir: false })])).toHaveLength(1);
  });
});

describe("formatStamp", () => {
  it("uses time today, Yesterday, weekday this week, then a date", () => {
    const now = new Date(2026, 9, 2, 12, 0).getTime(); // Friday
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 22).getTime();
    expect(formatStamp(at(2, 9), now)).not.toMatch(/Yesterday|day/);
    expect(formatStamp(at(1, 17), now)).toMatch(/^Yesterday /);
    expect(formatStamp(new Date(2026, 8, 29, 17, 22).getTime(), now)).toMatch(/^Tuesday /); // 3 days back
    expect(formatStamp(new Date(2026, 8, 12, 17, 22).getTime(), now)).toMatch(/Sep 12, /);
    expect(formatStamp(new Date(2025, 8, 12, 17, 22).getTime(), now)).toMatch(/2025/);
  });
});

describe("markdownToHtml", () => {
  it("renders task lists as styled boxes, not inputs the sanitizer would strip", () => {
    const html = markdownToHtml("- [x] shipped\n- [ ] next\n\n```ts\nconst a = 1;\n```");
    expect(html).toContain('<span class="task-box done" aria-hidden="true"></span>shipped');
    expect(html).toContain('<span class="task-box" aria-hidden="true"></span>next');
    expect(html).not.toContain("<input");
    expect(html).toContain('<code data-lang="ts">');
  });
});
