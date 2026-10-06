import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlSourceLine, previewContext } from "./annotation-source";

const page = `<!doctype html>
<html>
<head><title>a <div> in a title</title>
<script>document.body && "<div>"</script>
</head>
<body>
  <!-- <div>commented out</div> -->
  <div class="hero">
    <h1 id="title">Hi</h1>
  </div>
  <div class='card'>
    <button>Go</button>
  </div>
</body>
</html>`;

describe("htmlSourceLine", () => {
  it("finds the n-th tag, skipping comments and raw-text bodies", () => {
    expect(htmlSourceLine(page, { tag: "div", index: 0, count: 2 })).toBe(8);
    expect(htmlSourceLine(page, { tag: "div", index: 1, count: 2 })).toBe(11);
    expect(htmlSourceLine(page, { tag: "button", index: 0, count: 1 })).toBe(12);
  });
  it("prefers a unique id", () => {
    expect(htmlSourceLine(page, { tag: "h1", index: 5, count: 9, id: "title" })).toBe(9);
  });
  it("gives up when the page and the file disagree on the count (a script or an implied tag)", () => {
    expect(htmlSourceLine(page, { tag: "div", index: 2, count: 3 })).toBeUndefined();
    expect(htmlSourceLine("<table><tr><td>x</td></tr></table>", { tag: "tbody", index: 0, count: 1 })).toBeUndefined();
  });
  it("rejects a tag that is not a tag name", () => {
    expect(htmlSourceLine(page, { tag: "div|h1", index: 0, count: 2 })).toBeUndefined();
  });
});

describe("previewContext", () => {
  const info = { path: "/p/a.md", name: "a.md", kind: "markdown" as const, mode: "rendered" as const, modes: ["rendered" as const, "raw" as const] };
  it("adds nothing for a web page", async () => expect(await previewContext(undefined, 3, undefined)).toEqual({}));
  it("names the file instead of the token URL, with the Markdown block's line", async () => {
    expect(await previewContext(info, 12, undefined)).toEqual({ url: "/p/a.md", file: "/p/a.md", line: 12, styles: undefined });
    expect(await previewContext(info, undefined, undefined)).toStrictEqual({ url: "/p/a.md", file: "/p/a.md", styles: undefined });
  });
  it("maps a rendered HTML file's element to its line, and ignores a viewer line elsewhere", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigna-annotation-"));
    const path = join(dir, "page.html");
    await writeFile(path, page);
    const html = { path, name: "page.html", kind: "html" as const, mode: "rendered" as const, modes: ["rendered" as const, "raw" as const] };
    expect(await previewContext(html, 99, { tag: "button", index: 0, count: 1 })).toEqual({ url: path, file: path, line: 12 });
    expect(await previewContext({ ...html, mode: "raw" }, 99, { tag: "button", index: 0, count: 1 })).toEqual({ url: path, file: path });
  });
});
