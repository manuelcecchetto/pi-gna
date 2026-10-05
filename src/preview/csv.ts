// Small RFC 4180 reader for the table view: quoted fields, doubled quotes, newlines inside quotes, CRLF.

export interface CsvResult {
  rows: string[][];
  /** True when parsing stopped at `maxRows`. */
  truncated: boolean;
}

export function parseCsv(text: string, delimiter: string, maxRows: number): CsvResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = (): boolean => {
    row.push(field);
    field = "";
    // A blank line is not a row.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
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
