import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("reads quoted fields, escaped quotes and embedded newlines", () => {
    const { rows } = parseCsv('a,"b,1","say ""hi"""\r\n"x\ny",2,3\n', ",", 100);
    expect(rows).toEqual([["a", "b,1", 'say "hi"'], ["x\ny", "2", "3"]]);
  });

  it("skips blank lines and keeps a last row without a newline", () => {
    expect(parseCsv("a\tb\n\nc\td", "\t", 100).rows).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("stops at the row cap and says so", () => {
    const result = parseCsv("1\n2\n3\n4\n", ",", 2);
    expect(result.rows).toEqual([["1"], ["2"]]);
    expect(result.truncated).toBe(true);
    expect(parseCsv("1\n2\n", ",", 2).truncated).toBe(false);
  });
});
