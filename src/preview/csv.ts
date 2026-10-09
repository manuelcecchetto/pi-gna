// Small RFC 4180 reader for the table view: quoted fields, doubled quotes, newlines inside quotes, CRLF.

export interface CsvResult {
  rows: string[][];
  /** True when parsing stopped at `maxRows`. */
  truncated: boolean;
}

export function parseCsv(text: string, delimiter: string, maxRows: number): CsvResult {
  const rows: string[][] = [];
  let row: string[] = [];
  // A field is copied in slices, not a character at a time: `field` holds its finished parts (quoted ones), `start`
  // is where its current unquoted run begins.
  let field = "";
  let start = 0;
  const endRow = (): boolean => {
    row.push(field);
    field = "";
    // A blank line is not a row.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && field === "" && start === i) {
      // A quoted part runs to the next lone quote (a doubled one is a quote), or to the end of the text when unclosed.
      let from = i + 1;
      for (;;) {
        const close = text.indexOf('"', from);
        if (close === -1) {
          field += text.slice(from);
          i = text.length;
          break;
        }
        field += text.slice(from, close);
        if (text[close + 1] !== '"') {
          i = close;
          break;
        }
        field += '"';
        from = close + 2;
      }
      start = i + 1;
    } else if (ch === delimiter) {
      row.push(field + text.slice(start, i));
      field = "";
      start = i + 1;
    } else if (ch === "\n" || ch === "\r") {
      field += text.slice(start, i);
      if (ch === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
      if (endRow()) return { rows, truncated: i + 1 < text.length };
    }
  }
  field += text.slice(start);
  if (field !== "" || row.length > 0) endRow();
  return { rows, truncated: false };
}
