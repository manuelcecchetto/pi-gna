import { describe, expect, it } from "vitest";
import { markdownText } from "./markdown-text";

describe("markdownText", () => {
  it("keeps the words and drops the markup", () => {
    expect(markdownText("Needs **bold** notes and `code` with _emphasis_ ~~gone~~")).toBe("Needs bold notes and code with emphasis gone");
  });

  it("keeps link and image text, not their targets", () => {
    expect(markdownText("Done. See [the docs](https://example.com/docs) ![a chart](chart.png)")).toBe("Done. See the docs a chart");
  });

  it("puts blocks, list items and table cells on one line", () => {
    expect(markdownText("## Changed\n\n- one\n- [x] two\n\n| a | b |\n|---|---|\n| c | d |\n\n> quoted")).toBe("Changed one two a b c d quoted");
  });

  it("keeps code, escapes and characters HTML would escape as they are", () => {
    expect(markdownText("```ts\nconst a = 1 < 2;\n```\n\n\\*not emphasis\\* & <b>tag</b>")).toBe("const a = 1 < 2; *not emphasis* & tag");
  });

  it("leaves plain text alone", () => {
    expect(markdownText("Grep took forever")).toBe("Grep took forever");
    expect(markdownText("")).toBe("");
  });
});
