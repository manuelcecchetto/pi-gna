import { describe, expect, it } from "vitest";
import { JsonlSplitter } from "./jsonl";

describe("JsonlSplitter", () => {
  it("splits complete records across chunk boundaries", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n')).toEqual(['{"b":2}']);
  });

  it("keeps U+2028 and U+2029 inside records", () => {
    const splitter = new JsonlSplitter();
    const text = "line\u2028sep\u2029para";
    const record = JSON.stringify({ text });
    expect(record).toContain("\u2028");
    const lines = splitter.push(`${record}\n`);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).text).toBe(text);
  });

  it("strips CR before LF and skips blank lines", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("decodes multi-byte UTF-8 split across Buffer chunks", () => {
    const splitter = new JsonlSplitter();
    const bytes = Buffer.from('{"t":"é🙂"}\n', "utf8");
    const cut = bytes.indexOf(0xf0) + 2; // middle of the emoji
    expect(splitter.push(bytes.subarray(0, cut))).toEqual([]);
    expect(splitter.push(bytes.subarray(cut))).toEqual(['{"t":"é🙂"}']);
  });

  it("returns an unterminated trailing record on end()", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}']);
    expect(splitter.end()).toEqual(['{"b":2}']);
    expect(splitter.end()).toEqual([]);
  });
});
