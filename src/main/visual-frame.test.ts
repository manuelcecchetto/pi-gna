import { describe, expect, it } from "vitest";
import { VISUAL_CSP, visualAsset } from "./visual-frame";

describe("visualAsset", () => {
  const host = "pigna-visual://abcd1234ef";
  it("serves exactly the three frame assets", () => {
    expect(visualAsset(`${host}/doc`)?.file).toBe("doc.html");
    expect(visualAsset(`${host}/kit.css`)?.file).toBe("kit.css");
    expect(visualAsset(`${host}/kit.js`)?.file).toBe("kit.js");
  });
  it("refuses everything else", () => {
    for (const url of [
      `${host}/`,
      `${host}/doc/`,
      `${host}/../../etc/passwd`,
      `${host}/%2e%2e/secret`,
      `${host}/kit.js.map`,
      `${host}/constructor`,
      `${host}/__proto__`,
      "pigna-visual:///doc",
      "pigna-visual://x/doc",
      "app://abcd1234ef/doc",
      "not a url",
    ])
      expect(visualAsset(url), url).toBeNull();
  });
});

describe("VISUAL_CSP", () => {
  const directives = new Map(VISUAL_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
  it("allows no network, navigation or forms", () => {
    for (const name of ["default-src", "connect-src", "frame-src", "object-src", "form-action", "base-uri"]) expect(directives.get(name)).toBe("'none'");
  });
  it("allows only own and inline scripts and styles and local media", () => {
    expect(directives.get("script-src")).toBe("'self' 'unsafe-inline'");
    expect(directives.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(directives.get("img-src")).toBe("data: blob:");
    expect(directives.get("font-src")).toBe("data:");
    expect(directives.get("media-src")).toBe("data: blob:");
    expect(VISUAL_CSP).not.toMatch(/https?:|\*/);
  });
});
