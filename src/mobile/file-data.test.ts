import { describe, expect, it } from "vitest";
import { blockForLine, drawnOnPhone, linesBefore, prettyJson } from "./file-data";

describe("the phone's File screen", () => {
  it("draws text kinds and images itself and streams the rest", () => {
    for (const path of ["/p/README.md", "/p/a.ts", "/p/notes.txt", "/p/data.json", "/p/t.csv", "/p/shot.png", "/p/LICENSE", "/p/.env"]) expect(drawnOnPhone(path)).toBe(true);
    for (const path of ["/p/doc.pdf", "/p/deck.pptx", "/p/page.html", "/p/clip.mp4"]) expect(drawnOnPhone(path)).toBe(false);
  });

  it("finds the block a line falls in", () => {
    expect(blockForLine([1, 3, 8], 1)).toBe(0);
    expect(blockForLine([1, 3, 8], 5)).toBe(1);
    expect(blockForLine([1, 3, 8], 40)).toBe(2);
    expect(blockForLine([4, 9], 2)).toBe(0);
  });

  it("counts the front matter's lines and pretty-prints JSON it can parse", () => {
    const text = "---\ntitle: x\n---\n# Body";
    expect(linesBefore(text, "# Body")).toBe(3);
    expect(linesBefore("# Body", "# Body")).toBe(0);
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("{ // jsonc")).toBe("{ // jsonc");
  });
});
