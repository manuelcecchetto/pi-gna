import { describe, expect, it } from "vitest";
import { embeddedImageTargets, inlineVisualImages, visualImageTargets } from "./markdown-images";

describe("embeddedImageTargets", () => {
  it("lists the local images an answer embeds, as the chat renders them", () => {
    const answer = [
      "Before ![shot](/tmp/shots/a.png) and ![](rel/b%20c.jpg 'title').",
      "",
      "| Before | After |",
      "|---|---|",
      "| ![x](<d e.png>) | <img src=\"/abs/f.webp\" width=\"200\"> |",
      "",
      "<table><tr><td><img alt='g' src='g.gif'></td></tr></table>",
      "",
      "Not images: [link](h.png), ![web](https://example.com/i.png), `![code](j.png)`.",
      "",
      "```md",
      "![fenced](k.png)",
      "```",
    ].join("\n");
    expect(embeddedImageTargets(answer)).toEqual(["/tmp/shots/a.png", "rel/b%20c.jpg", "d e.png", "/abs/f.webp", "g.gif"]);
  });

  it("counts the local images of a visual fence, which the chat inlines into its frame", () => {
    const answer = ["```visual", '<img src="art/engine.png"><svg><image href="/abs/flame.svg"/></svg>', "```"].join("\n");
    expect(embeddedImageTargets(answer)).toEqual(["art/engine.png", "/abs/flame.svg"]);
  });
});

describe("visual images", () => {
  const html = [
    '<img alt="cutaway" src="art/engine.png" width="320">',
    "<svg viewBox='0 0 10 10'><image x=\"0\" xlink:href='/abs/flame.svg' /><image href=\"a&amp;b.png\"/></svg>",
    '<img src="https://example.com/x.png"><img src="data:image/png;base64,AAAA"><a href="notes.png">notes</a>',
  ].join("");

  it("lists img src and SVG image href, local ones only", () => {
    expect(visualImageTargets(html)).toEqual(["art/engine.png", "/abs/flame.svg", "a&b.png"]);
  });

  it("swaps the loaded ones for their data URLs and leaves everything else as written", () => {
    const out = inlineVisualImages(html, new Map([["art/engine.png", "data:image/png;base64,QQ"], ["a&b.png", "data:image/png;base64,Qg"]]));
    expect(out).toContain('<img alt="cutaway" src="data:image/png;base64,QQ" width="320">');
    expect(out).toContain('<image href="data:image/png;base64,Qg"/>');
    expect(out).toContain("xlink:href='/abs/flame.svg'");
    expect(out).toContain('<img src="https://example.com/x.png">');
    expect(out).toContain('<a href="notes.png">');
  });
});
