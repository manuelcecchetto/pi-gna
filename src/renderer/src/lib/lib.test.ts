import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";
import { formatStamp, formatTokens } from "./format";
import { type LexedMarkdown, lexMarkdown, markdownBlockLines, markdownBlockToHtml, markdownToHtml, VISUAL_MAX_BYTES } from "./markdown";
import { applyQueueOp } from "../../../shared/queue";
import { ATP_DETAIL, clampPanel, clampSidebarWidth, sidebarDrag } from "./layout";
import { cacheHitRate, summarizeContext } from "./context";
import { resolveReserveTokens } from "../../../shared/compaction";
import { attachmentImages, formatFileMentions, fromImageData, fromPicked, mergeAttachments, splitFileMentions } from "./attachments";
import { parsePartialJson } from "../../../shared/partial-json";
import { lightboxAt, lightboxStep } from "./lightbox";

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

describe("markdown file links", () => {
  it("renders local targets as file chips without an href", () => {
    const html = markdownToHtml("[manager.ts](src/main/manager.ts:120) and [design](<docs/A b.md#L10>) and [abs](/p/x.pdf)");
    expect(html).toContain('data-file="src/main/manager.ts:120"');
    expect(html).toContain('data-file="docs/A b.md#L10"');
    expect(html).toContain('data-kind="code"');
    expect(html).toContain('data-kind="pdf"');
    expect(html).not.toContain("href");
    expect(html).toContain("manager.ts</span>");
  });

  it("keeps plain hrefs for the file viewer", () => {
    const html = markdownToHtml("[spec](docs/a.docx) and [b](../b.md)", { fileLinks: false });
    expect(html).toContain('href="docs/a.docx"');
    expect(html).toContain('href="../b.md"');
    expect(html).not.toContain("data-file");
    expect(markdownToHtml("[spec](docs/a.docx)")).toContain('data-file="docs/a.docx"');
  });

  // DOMPurify needs a DOM, which the node test environment lacks: this checks the pre-sanitize HTML, where
  // script URLs are still ordinary hrefs for the sanitizer to strip, exactly as before.
  it("leaves web links alone", () => {
    const html = markdownToHtml("[a](https://x.com/a.ts) [b](mailto:a@b.c) [c](javascript:alert(1)) [d](#top)");
    expect(html).toContain('href="https://x.com/a.ts"');
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('href="javascript:alert(1)"');
    expect(html).not.toContain("data-file");
  });

  it("escapes the target and keeps file links out of event attributes", () => {
    const html = markdownToHtml('[x](<a"onmouseover="alert(1).ts>)');
    expect(html).not.toMatch(/ onmouseover=/);
  });

  it("renders local images as placeholders the component loads, and leaves web images alone", () => {
    const html = markdownToHtml('![login page](shots/a%20b.png) ![](/abs/chart.svg) ![notes](docs/x.md) ![web](https://x.com/a.png) ![x](<a"onerror="alert(1).png>)', { localImages: true });
    expect(html).toContain('data-image="shots/a%20b.png" data-file="shots/a%20b.png" data-kind="image">login page</span>');
    expect(html).toContain('data-image="/abs/chart.svg"');
    expect(html).toContain(">chart.svg</span>");
    expect(html).toContain('data-file="docs/x.md" data-kind="markdown">notes</span>');
    expect(html).not.toContain('data-image="docs/x.md"');
    expect(html).toContain('<img src="https://x.com/a.png" alt="web">');
    expect(html).not.toMatch(/ onerror=/);
    // The file viewer renders Markdown files with the same code and resolves relative images itself.
    expect(markdownToHtml("![pic](pic.png)")).toBe('<p><img src="pic.png" alt="pic"></p>\n');
  });

  it("loads a raw <img> with a local src like ![](), keeping a plain width and height, and leaves the rest of the HTML", () => {
    const html = markdownToHtml(
      '<table><tr><td><img src="shots/01 welcome.png" alt="Welcome" width="180" height="40%"><br><sub>Welcome</sub></td>' +
        "<td><img src='/abs/b.png' width=\"calc(1px)\" onerror=\"alert(1)\"/></td><td><img src=\"https://x.com/a.png\"></td>" +
        '<td><img alt="x&amp;y" src="a&quot;b.png"></td><td><img src="notes.md" alt="notes"></td></tr></table>\n\nText <img src="/abs/c.png"> inline.',
      { localImages: true },
    );
    expect(html).toContain('data-image="shots/01 welcome.png" data-file="shots/01 welcome.png" data-kind="image" data-width="180" data-height="40%">Welcome</span><br><sub>Welcome</sub>');
    expect(html).toContain('data-image="/abs/b.png" data-file="/abs/b.png" data-kind="image">b.png</span>');
    expect(html).toContain('<img src="https://x.com/a.png">');
    expect(html).toContain('data-image="a&quot;b.png" data-file="a&quot;b.png" data-kind="image">x&amp;y</span>');
    expect(html).toContain('data-file="notes.md" data-kind="markdown">notes</span>');
    expect(html).toContain('Text <span class="file-link chat-image" role="link" tabindex="0" data-image="/abs/c.png"');
    expect(html).not.toMatch(/onerror|calc/);
    // The file viewer keeps raw images as they are.
    expect(markdownToHtml('<img src="pic.png">')).toBe('<img src="pic.png">');
  });

  it("marks path-like inline code as candidates only", () => {
    const html = markdownToHtml("`src/a.ts:3` `1.2.3` `and/or` `a.b` `https://x.com/a.ts` `foo()`");
    expect(html).toContain('<code data-path="src/a.ts:3">');
    expect(html.match(/data-path/g)).toHaveLength(1);
  });
});

describe("lightbox paging", () => {
  it("opens on the clicked image within its set, or alone when it is not in one", () => {
    expect(lightboxAt("b", ["a", "b", "c"])).toEqual({ images: ["a", "b", "c"], index: 1 });
    expect(lightboxAt("z", ["a", "b"])).toEqual({ images: ["z"], index: 0 });
    expect(lightboxAt("z")).toEqual({ images: ["z"], index: 0 });
  });

  it("steps through the set and stops at the ends", () => {
    const view = lightboxAt("b", ["a", "b", "c"]);
    expect(lightboxStep(view, 1).index).toBe(2);
    expect(lightboxStep(view, -1).index).toBe(0);
    expect(lightboxStep(lightboxStep(view, 1), 1).index).toBe(2);
    const first = lightboxAt("a", ["a", "b"]);
    expect(lightboxStep(first, -1)).toBe(first);
  });
});

describe("markdownToHtml visual fences", () => {
  const on = { visuals: true };
  const fence = (body: string) => "```visual\n" + body + "\n```";

  it("emits a placeholder only when visuals are on", () => {
    const md = "Answer.\n\n" + fence("<b>hi</b>");
    const html = markdownToHtml(md, on);
    expect(html).toContain('<div class="visual" data-visual>');
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
    for (const off of [markdownToHtml(md), markdownToHtml(md, { visuals: false })]) {
      expect(off).not.toContain("data-visual");
      expect(off).toContain('<code data-lang="visual">');
    }
  });

  it("falls back to a labelled code block with a note over the cap", () => {
    const html = markdownToHtml(fence("x".repeat(VISUAL_MAX_BYTES + 1)), on);
    expect(html).not.toContain("data-visual");
    expect(html).toContain("visual-note");
    expect(html).toContain('<code data-lang="visual">');
    expect(markdownToHtml(fence("x".repeat(VISUAL_MAX_BYTES)), on)).toContain("data-visual");
  });

  it("keeps an unterminated fence a code block while streaming", () => {
    const html = markdownToHtml("```visual\n<div>partial", on);
    expect(html).not.toContain("data-visual");
    expect(html).toContain('<code data-lang="visual">');
  });

  it("handles several visuals, and visuals in lists and blockquotes", () => {
    const html = markdownToHtml([fence("<i>1</i>"), "", "- item\n\n  " + "```visual\n  <i>2</i>\n  ```", "", "> " + "```visual\n> <i>3</i>\n> ```"].join("\n"), on);
    expect(html.match(/data-visual/g)).toHaveLength(3);
    expect(html).toContain("<li>");
    expect(html).toContain("<blockquote>");
  });

  it("keeps a visual fence nested in a longer fence as code", () => {
    const html = markdownToHtml("````md\n```visual\n<b>x</b>\n```\n````", on);
    expect(html).not.toContain("data-visual");
    expect(html).toContain('<code data-lang="md">');
  });

  it("never emits script or iframe tags from the fragment", () => {
    const html = markdownToHtml(fence('<script>alert(1)</script><iframe src="x"></iframe>'), on);
    expect(html).not.toMatch(/<(script|iframe)/i);
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("applyQueueOp", () => {
  const queues = { steering: ["fix the test", "also lint"], followUp: ["then summarize", "fix the test"] };

  it("removes by kind and text, keeping the order of the rest", () => {
    expect(applyQueueOp(queues, { type: "remove", kind: "steering", text: "fix the test" })).toEqual({
      queues: { steering: ["also lint"], followUp: ["then summarize", "fix the test"] },
      found: true,
    });
  });

  it("steers a follow-up now, or defers a steer to after the run, appending to the other queue", () => {
    expect(applyQueueOp(queues, { type: "move", kind: "followUp", text: "then summarize" }).queues).toEqual({
      steering: ["fix the test", "also lint", "then summarize"],
      followUp: ["fix the test"],
    });
    expect(applyQueueOp(queues, { type: "move", kind: "steering", text: "also lint" }).queues).toEqual({
      steering: ["fix the test"],
      followUp: ["then summarize", "fix the test", "also lint"],
    });
  });

  it("is a no-op when pi already delivered the item", () => {
    expect(applyQueueOp(queues, { type: "remove", kind: "steering", text: "gone" })).toEqual({ queues, found: false });
  });
});

describe("context meter", () => {
  const stats = (tokens: number | null, contextWindow = 1_000_000) => ({
    sessionId: "s",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextUsage: { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 },
  });

  it("resolves pi's reserve: exact model override, then the ordinary setting, then the default", () => {
    const settings = { reserveTokens: 32_768, modelOverrides: { "claude-bridge/claude-opus-5-5": { reserveTokens: 400_000 } } };
    expect(resolveReserveTokens(settings, "claude-bridge", "claude-opus-5-5")).toBe(400_000);
    expect(resolveReserveTokens(settings, "openai", "gpt")).toBe(32_768);
    expect(resolveReserveTokens(undefined)).toBe(16_384);
    expect(resolveReserveTokens({ reserveTokens: -1 })).toBe(16_384);
  });

  it("measures room until auto-compaction and colors by it", () => {
    const at57 = summarizeContext(stats(569_362), 32_768, true);
    expect(at57).toMatchObject({ used: 569_362, compactAt: 967_232, left: 397_870, level: "ok" });
    expect(at57?.percent).toBeCloseTo(56.94, 1);
    expect(summarizeContext(stats(700_000), 32_768, true)?.level).toBe("warn");
    expect(summarizeContext(stats(900_000), 32_768, true)?.level).toBe("high");
  });

  it("uses the full window when auto-compaction is off, and is unknown right after compaction", () => {
    expect(summarizeContext(stats(850_000), 32_768, false)).toMatchObject({ compactAt: null, left: 150_000, level: "warn" });
    expect(summarizeContext(stats(null), 32_768, true)).toMatchObject({ used: null, percent: null, level: "unknown" });
    expect(summarizeContext(undefined, 32_768, true)).toBeUndefined();
    // This session's totals: almost every prompt token came from cache.
    expect(cacheHitRate({ input: 684, cacheRead: 124_707_648, cacheWrite: 2_868_363 })).toBeCloseTo(0.9775, 3);
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate({ input: 1000, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect([formatTokens(684), formatTokens(569_362), formatTokens(1_000_000), formatTokens(124_707_648)]).toEqual(["684", "569k", "1M", "124.7M"]);
  });
});

describe("clampSidebarWidth", () => {
  it("keeps the sidebar between its bounds and leaves the chat at least 520px", () => {
    expect(clampSidebarWidth(300, 1600)).toBe(300);
    expect(clampSidebarWidth(100, 1600)).toBe(220);
    expect(clampSidebarWidth(900, 1600)).toBe(480);
    expect(clampSidebarWidth(450, 900)).toBe(380); // 900 - 520
    expect(clampSidebarWidth(450, 600)).toBe(220); // tiny window: the minimum still wins
    expect(clampSidebarWidth(Number.NaN, 1600)).toBe(268);
  });
});

describe("sidebarDrag", () => {
  it("collapses once dragged near the window edge instead of stopping at the minimum width", () => {
    expect(sidebarDrag(300, 1600)).toEqual({ collapsed: false, width: 300 });
    expect(sidebarDrag(160, 1600)).toEqual({ collapsed: false, width: 220 }); // between edge zone and minimum: hold at minimum
    expect(sidebarDrag(119, 1600)).toEqual({ collapsed: true });
    expect(sidebarDrag(-20, 1600)).toEqual({ collapsed: true });
  });
});

describe("clampPanel", () => {
  it("keeps an ATP panel between its bounds and within the room the graph leaves", () => {
    expect(clampPanel(500, ATP_DETAIL)).toBe(500);
    expect(clampPanel(120, ATP_DETAIL)).toBe(300);
    expect(clampPanel(2000, ATP_DETAIL)).toBe(900);
    expect(clampPanel(600, ATP_DETAIL, 450.6)).toBe(451); // the graph would get narrower than its minimum
    expect(clampPanel(600, ATP_DETAIL, 50)).toBe(300); // no room at all: the minimum still wins
    expect(clampPanel(Number.NaN, ATP_DETAIL)).toBe(380);
  });
});

describe("markdown blocks", () => {
  const options = { visuals: true, localImages: true };
  const html = (lexed: LexedMarkdown) => lexed.blocks.map((block) => markdownBlockToHtml(block, options)).join("");
  const docs = [
    "\n\n# Title\n\nSome text\nwrapped.\n\n- a\n- b\n\n  continued\n\n1. one\n\n\n2. two\n\n```ts\nx\n```\n\n> quote\nlazy\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nSetext\n===\n\n    indented code\n\n- [x] done\n- [ ] open \n",
    "Intro.\n\n<details>\n<summary>More</summary>\n\n**inside** and `src/a.ts:3`\n\n</details>\n\nText with <b>bold\n\nstill bold</b> after.\n\n<br>\n\nEnd ![shot](a.png) [file](src/main/x.ts:1).\n",
    "Answer.\n\n```visual\n<div class=\"stack\"><b>hi</b></div>\n```\n\nAfter the visual.\r\n\r\nCRLF line.\r\n",
  ];

  it("render block by block to the same HTML as the whole text", () => {
    for (const doc of docs) expect(html(lexMarkdown(doc))).toBe(markdownToHtml(doc.replace(/\r\n?/g, "\n"), options));
  });

  it("keep raw HTML that wraps other blocks in one block", () => {
    const { blocks } = lexMarkdown(docs[1] as string);
    expect(blocks.map((block) => block.raw.split("\n")[0])).toEqual(["Intro.", "<details>", "Text with <b>bold", "<br>", "End ![shot](a.png) [file](src/main/x.ts:1)."]);
  });

  it("lex a stream on from the last frame to what lexing each frame whole gives, keeping the finished blocks", () => {
    for (const doc of docs) {
      let lexed: LexedMarkdown | undefined;
      for (let end = 1; end <= doc.length; end++) {
        const previous: LexedMarkdown | undefined = lexed;
        lexed = lexMarkdown(doc.slice(0, end), previous);
        expect(html(lexed)).toBe(markdownToHtml(doc.slice(0, end).replace(/\r\n?/g, "\n"), options));
        // Every block but the last two of the previous frame is the same object, so its HTML is not rendered again.
        if (previous) for (let i = 0; i < previous.blocks.length - 2; i++) expect(lexed.blocks[i]).toBe(previous.blocks[i]);
      }
    }
  });

  it("lex every frame whole once a link reference definition shows up, since it reaches back", () => {
    let lexed = lexMarkdown("See [the docs][d].\n\nMore.\n\nAnd more.\n\n");
    lexed = lexMarkdown("See [the docs][d].\n\nMore.\n\nAnd more.\n\n[d]: https://x.y\n", lexed);
    expect(html(lexed)).toContain('<a href="https://x.y">the docs</a>');
    const next = lexMarkdown(`${lexed.text}\nTail.`, lexed);
    expect(next.blocks[0]).not.toBe(lexed.blocks[0]);
    expect(html(next)).toBe(markdownToHtml(next.text, options));
  });
});

describe("markdownBlockLines", () => {
  it("gives the line each rendered block starts on", () => {
    const source = "# Title\n\nSome text\nwrapped.\n\n- a\n- b\n\n```ts\nx\n```\n\n[ref]: https://x.y\n\n> quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
    expect(markdownBlockLines(source)).toEqual([1, 3, 6, 9, 15, 17]);
    expect(markdownBlockLines(source.replaceAll("\n", "\r\n"))).toEqual([1, 3, 6, 9, 15, 17]);
  });
});
