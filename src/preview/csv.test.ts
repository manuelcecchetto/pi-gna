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

  it("copies fields in slices around quotes, lone CRs and an unclosed quote", () => {
    expect(parseCsv('ab"c,"d""e"f,""\rx,"g\r\nh', ",", 100).rows).toEqual([["ab\"c", 'd"ef', ""], ["x", "g\r\nh"]]);
    expect(parseCsv('"a"b"c",""""\n', ",", 100).rows).toEqual([['ab"c"', '"']]);
  });

  it("reads like a character-at-a-time reader on random text", () => {
    const alphabet = ["a", "b", ",", '"', "\n", "\r", "\t", " "];
    let seed = 7;
    const random = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let k = 0; k < 20_000; k++) {
      let text = "";
      for (let length = random(14); length > 0; length--) text += alphabet[random(alphabet.length)];
      for (const delimiter of [",", "\t"]) {
        for (const maxRows of [1, 2, 100]) expect(parseCsv(text, delimiter, maxRows), JSON.stringify([text, delimiter, maxRows])).toEqual(byCharacter(text, delimiter, maxRows));
      }
    }
  });
});

/** The reader as it was before it copied slices: one character appended at a time. */
function byCharacter(text: string, delimiter: string, maxRows: number): ReturnType<typeof parseCsv> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = (): boolean => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (endRow()) return { rows, truncated: i + 1 < text.length };
    } else field += ch;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, truncated: false };
}
