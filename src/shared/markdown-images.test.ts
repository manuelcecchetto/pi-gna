import { describe, expect, it } from "vitest";
import { embeddedImageTargets } from "./markdown-images";

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
});
