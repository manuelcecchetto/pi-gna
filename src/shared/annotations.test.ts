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
});

describe("parseAnnotations", () => {
  it("keeps well-formed annotations and drops a bad crop", () => {
    expect(parseAnnotations([{ ...note, image: "AAAA" }])[0]?.image).toBe("AAAA");
    expect(parseAnnotations([{ ...note, image: "not base64!" }])[0]?.image).toBeUndefined();
  });
  it("rejects a wrong shape", () => {
    expect(() => parseAnnotations("x")).toThrow();
    expect(() => parseAnnotations([null])).toThrow();
    expect(() => parseAnnotations(Array(21).fill(note))).toThrow();
  });
});
