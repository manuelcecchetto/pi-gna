import { describe, expect, it } from "vitest";
import { VISUAL_CSP, visualAsset, visualFrameToKill, visualRemoteAsset } from "./visual-frame";

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

describe("visualRemoteAsset", () => {
  it("maps the frame paths to the same three assets", () => {
    expect(visualRemoteAsset("/visual/abcd1234ef/doc")?.file).toBe("doc.html");
    expect(visualRemoteAsset("/visual/abcd1234ef/kit.css")?.file).toBe("kit.css");
    expect(visualRemoteAsset("/visual/abcd1234ef/kit.js")?.file).toBe("kit.js");
  });
  it("refuses anything else", () => {
    for (const path of ["/visual/abcd1234ef/", "/visual/abcd1234ef/doc/x", "/visual/x/doc", "/visual/abcd1234ef/../doc", "/visual/abcd1234ef/__proto__", "/visual//doc", "/visual/abcd1234ef/kit.js.map"])
      expect(visualRemoteAsset(path), path).toBeNull();
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

describe("visualFrameToKill", () => {
  const id = "0123456789abcdef";
  const frames = [
    { url: "app://pigna/index.html", osProcessId: 10 },
    { url: `pigna-visual://${id}/doc`, osProcessId: 20 },
    { url: "pigna-visual://fedcba9876543210/doc", osProcessId: 30 },
  ];
  it("picks the process hosting that frame", () => {
    expect(visualFrameToKill(frames, id, 10)).toBe(20);
  });
  it("never kills the app window's process", () => {
    expect(visualFrameToKill(frames, id, 20)).toBeUndefined();
  });
  it("refuses malformed ids and unknown frames", () => {
    expect(visualFrameToKill(frames, "app", 10)).toBeUndefined();
    expect(visualFrameToKill(frames, "../../index", 10)).toBeUndefined();
    expect(visualFrameToKill(frames, "aaaaaaaaaaaaaaaa", 10)).toBeUndefined();
  });
});
