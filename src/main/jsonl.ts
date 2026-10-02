// Strict JSONL framing: split only on LF (strip one preceding CR). Unlike Node's readline,
// U+2028/U+2029 stay inside records, as pi's RPC docs require.
import { StringDecoder } from "node:string_decoder";

export class JsonlSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Uint8Array | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk as Buffer);
    return this.drain();
  }

  /** Returns a trailing record that had no final LF. */
  end(): string[] {
    this.buffer += this.decoder.end();
    const rest = this.drain();
    const tail = stripCr(this.buffer);
    this.buffer = "";
    return tail.trim() ? [...rest, tail] : rest;
  }

  private drain(): string[] {
    const lines: string[] = [];
    let start = 0;
    let index = this.buffer.indexOf("\n", start);
    while (index !== -1) {
      const line = stripCr(this.buffer.slice(start, index));
      if (line.trim()) lines.push(line);
      start = index + 1;
      index = this.buffer.indexOf("\n", start);
    }
    this.buffer = this.buffer.slice(start);
    return lines;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
