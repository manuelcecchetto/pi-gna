import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";
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
