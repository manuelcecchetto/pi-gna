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

describe("ask_user", () => {
  const questions = [
    { id: "closed", prompt: "Renaming a closed chat: how?", options: [{ label: "Append session_info", description: "Same record pi writes" }, { label: "Open it first" }], default: "Open it first" },
    { id: "order", prompt: "Sort order?", options: ["Newest", "Oldest"], multi: true, default: ["Newest"] },
    { id: "note", prompt: "Anything else?" },
  ];
  const ask: ToolCall = { type: "toolCall", id: "a1", name: "ask_user", arguments: { questions } };
  const renderAsk = (run?: ToolRun, toolCall = ask) => renderToStaticMarkup(createElement(ToolDetails, { call: toolCall, run }));
  const normalized = [
    { id: "closed", prompt: "Renaming a closed chat: how?", options: [{ label: "Append session_info", description: "Same record pi writes" }, { label: "Open it first" }], multi: false, allowOther: true, defaultPicks: [1] },
    { id: "order", prompt: "Sort order?", options: [{ label: "Newest" }, { label: "Oldest" }], multi: true, allowOther: true, defaultPicks: [0] },
    { id: "note", prompt: "Anything else?", options: [], multi: false, allowOther: true, defaultPicks: [] },
  ];
  const chosen = (markup: string) => [...markup.matchAll(/data-chosen="true"[^>]*>.*?<span class="text-fg">([^<]+)</g)].map((match) => match[1]);

  it("shows each prompt with its options, the chosen ones filled, and no JSON", () => {
    const details = {
      questions: normalized,
      answers: [
        { id: "closed", values: ["Append session_info"], custom: false, source: "user" },
        { id: "order", values: ["Newest", "by name"], custom: true, source: "user" },
        { id: "note", values: [], custom: false, source: "skipped" },
      ],
      cancelled: false,
    };
    const markup = renderAsk({ status: "done", startedAt: 1, result: { content: [{ type: "text", text: "raw answer text" }], details } });
    const shown = text(markup);
    expect(shown).toContain("Renaming a closed chat: how?");
    expect(shown).toContain("Same record pi writes");
    expect(chosen(markup)).toEqual(["Append session_info", "Newest", "by name"]);
    expect(shown).toContain("(not answered)");
    expect(shown).not.toContain('"questions"');
    expect(shown).not.toContain("raw answer text");
    expect(shown).not.toContain("default");
  });

  it("says where an answer came from when the user did not choose it", () => {
    const details = {
      questions: normalized.slice(0, 2),
      answers: [
        { id: "closed", values: ["Open it first"], custom: false, source: "default" },
        { id: "order", values: ["Newest"], custom: false, source: "skipped" },
      ],
      cancelled: false,
    };
    const shown = text(renderAsk({ status: "done", startedAt: 1, result: { content: [], details } }));
    expect(shown).toContain("default: the countdown ran out");
    expect(shown).toContain("skipped: took the default");
  });

  it("marks the defaults while the questions wait for an answer", () => {
    const markup = renderAsk({ status: "running", startedAt: 1 });
    expect(chosen(markup)).toEqual([]);
    expect(text(markup).match(/default/g)).toHaveLength(2);
    expect(text(markup)).toContain("Waiting for an answer");
  });

  it("says the user declined", () => {
    const shown = text(renderAsk({ status: "done", startedAt: 1, result: { content: [], details: { questions: normalized, answers: [], cancelled: true } } }));
    expect(shown).toContain("Declined to answer");
    expect(shown).toContain("Sort order?");
  });

  it("falls back to the arguments as JSON when they are not questions", () => {
    const shown = text(renderAsk(undefined, { ...ask, arguments: { questions: [] } }));
    expect(shown).toContain('"questions": []');
  });
});
