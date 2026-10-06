import { describe, expect, it } from "vitest";
import { formatAnnotations, parseAnnotations } from "./annotations";

const note = { id: "a", url: "http://localhost:3000/", title: "App", selector: "#go", label: 'button "Go"', html: "<button>\n  Go</button>", comment: "too small" };

describe("formatAnnotations", () => {
  it("is empty without annotations", () => expect(formatAnnotations([])).toBe(""));
  it("lists the comments and mentions crops only when there are some", () => {
    expect(formatAnnotations([note])).toContain("1. too small\n   page: http://localhost:3000/ (App)");
    expect(formatAnnotations([note])).not.toContain("Attached images");
    expect(formatAnnotations([{ ...note, image: "AAAA" }])).toContain("Attached images are crops");
  });
  it("names a previewed file and line instead of the page, with the element's box and styles", () => {
    const text = formatAnnotations([{ ...note, url: "/p/a.md", file: "/p/a.md", line: 12, box: "120x32 at 4,8", viewport: "800x600", styles: "font: 14px/20px 400 Inter" }]);
    expect(text).toContain("   file: /p/a.md:12\n   element:");
    expect(text).not.toContain("page:");
    expect(text).toContain("   box: 120x32 at 4,8 in a 800x600 viewport\n   styles: font: 14px/20px 400 Inter");
    expect(text).toContain("A file line is where the element");
    expect(formatAnnotations([note])).not.toMatch(/box:|styles:|file line/);
  });
});

describe("parseAnnotations", () => {
  it("keeps well-formed annotations and drops a bad crop", () => {
    expect(parseAnnotations([{ ...note, image: "AAAA" }])[0]?.image).toBe("AAAA");
    expect(parseAnnotations([{ ...note, image: "not base64!" }])[0]?.image).toBeUndefined();
  });
  it("keeps the preview and layout details, dropping a bad line", () => {
    const [a] = parseAnnotations([{ ...note, file: "/p/a.md", line: 3, box: "1x1 at 0,0", viewport: "800x600", styles: "color: red" }]);
    expect(a).toMatchObject({ file: "/p/a.md", line: 3, box: "1x1 at 0,0", viewport: "800x600", styles: "color: red" });
    expect(parseAnnotations([{ ...note, line: -1 }])[0]).not.toHaveProperty("line");
    expect(parseAnnotations([note])[0]).not.toHaveProperty("file");
  });
  it("rejects a wrong shape", () => {
    expect(() => parseAnnotations("x")).toThrow();
    expect(() => parseAnnotations([null])).toThrow();
    expect(() => parseAnnotations(Array(21).fill(note))).toThrow();
  });
});
