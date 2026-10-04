import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";
import { formatStamp, formatTokens } from "./format";
import { markdownToHtml, VISUAL_MAX_BYTES } from "./markdown";
import { applyQueueOp } from "../../../shared/queue";
import { ATP_DETAIL, clampPanel, clampSidebarWidth, sidebarDrag } from "./layout";
import { cacheHitRate, summarizeContext } from "./context";
import { resolveReserveTokens } from "../../../shared/compaction";
import { attachmentImages, formatFileMentions, fromImageData, fromPicked, mergeAttachments, splitFileMentions } from "./attachments";
import { parsePartialJson } from "../../../shared/partial-json";

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
