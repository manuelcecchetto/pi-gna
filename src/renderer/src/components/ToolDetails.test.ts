import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../../../shared/protocol";
import type { ToolRun } from "../../../shared/session-state";
import { lastLines, ToolDetails } from "./ToolDetails";

vi.mock("./Markdown", () => ({ CodeView: ({ code }: { code: string }) => createElement("pre", null, code) }));

const call: ToolCall = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } };
const output = (lines: number, line = (n: number) => `line ${n}`) => Array.from({ length: lines }, (_, i) => `${line(i + 1)}\n`).join("");
const render = (run: ToolRun) => renderToStaticMarkup(createElement(ToolDetails, { call, run }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replaceAll("&quot;", '"');

describe("lastLines", () => {
  it("cuts the last lines, a trailing newline ending the last one, and counts the lines before them", () => {
    expect(lastLines("1\n2\n3\n", 2)).toEqual({ tail: "2\n3\n", before: 1 });
    expect(lastLines("1\n2\n3", 2)).toEqual({ tail: "2\n3", before: 1 });
    expect(lastLines("1\n2\n3\n", 3)).toEqual({ tail: "1\n2\n3\n", before: 0 });
    expect(lastLines("1\n2\n3\n", 9)).toEqual({ tail: "1\n2\n3\n", before: 0 });
    expect(lastLines("\n\n\nx", 1)).toEqual({ tail: "x", before: 3 });
    expect(lastLines("", 2)).toEqual({ tail: "", before: 0 });
  });
});

describe("bash output", () => {
  it("shows a running command's last 60 lines under a count of the earlier ones", () => {
    const markup = render({ status: "running", startedAt: 1, partial: { content: [{ type: "text", text: output(500) }] } });
    const shown = text(markup);
    expect(shown).toContain("⋯ 440 earlier lines\nline 441\n");
    expect(shown).toMatch(/line 500\n$/);
    expect(shown).not.toContain("line 440\n");
    expect(markup).toContain('<span class="select-none text-faint">⋯ 440 earlier lines');
    expect(markup).not.toContain("Show all");
    // A short run shows all of it, with no count.
    expect(text(render({ status: "running", startedAt: 1, partial: { content: [{ type: "text", text: output(60) }] } }))).toMatch(/^\$ makeline 1\n/);
  });

  it("carries a style set before the tail into it", () => {
    const red = `\x1b[31m${output(70)}`;
    const markup = render({ status: "running", startedAt: 1, partial: { content: [{ type: "text", text: red }] } });
    expect(markup).toContain('<span style="color:#ff6b6b">line 11\n');
  });

  it("shows a finished command's first 400 lines, as before", () => {
    const markup = render({ status: "done", startedAt: 1, result: { content: [{ type: "text", text: output(500) }] } });
    const shown = text(markup);
    expect(shown).toContain("line 1\nline 2\n");
    expect(shown).toContain("line 400Show all 501 lines");
    expect(shown).not.toContain("earlier lines");
  });
});
