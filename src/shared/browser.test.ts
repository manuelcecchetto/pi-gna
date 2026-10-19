import { describe, expect, it } from "vitest";
import { isLocalUrl, mediaFeatures, mediaLine, mergeMedia, normalizeAddress, pageToolsText, screenshotSize, viewportAction, viewportLine } from "./browser";
import { resolveViewport } from "./viewport";

describe("normalizeAddress", () => {
  it("adds http for local dev servers and https for domains", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000/app");
    expect(normalizeAddress("app.localhost:8080")).toBe("http://app.localhost:8080");
    expect(normalizeAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeAddress("https://pi.dev")).toBe("https://pi.dev");
  });

  it("searches for anything else and never yields a javascript: URL", () => {
    expect(normalizeAddress("electron webcontentsview")).toBe("https://duckduckgo.com/?q=electron%20webcontentsview");
    expect(normalizeAddress("javascript:alert(1)")).toMatch(/^https:\/\/duckduckgo\.com\//);
  });
});

describe("isLocalUrl", () => {
  it("allows loopback, *.localhost and files only", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1", "http://[::1]:8080/x", "http://my.localhost", "file:///tmp/a.html"]) {
      expect(isLocalUrl(url)).toBe(true);
    }
    for (const url of ["https://example.com", "http://localhost.evil.com", "http://10.0.0.1", "not a url"]) {
      expect(isLocalUrl(url)).toBe(false);
    }
  });
});

describe("viewport agent helpers", () => {
  it("shapes tool arguments", () => {
    expect(viewportAction({ reset: true, preset: "ipad" })).toEqual({ action: "viewport", reset: true });
    expect(viewportAction({ preset: "iphone-15", dpr: undefined })).toEqual({ action: "viewport", set: { preset: "iphone-15" } });
    expect(viewportAction({})).toEqual({ action: "viewport" });
  });
  it("describes the viewport", () => {
    const spec = resolveViewport({ preset: "iphone-15", source: "agent" });
    expect(viewportLine(spec)).toBe("Viewport: 393x852 @3x, mobile, iPhone 15 (set by you)");
    expect(viewportLine({ ...spec, source: "user" })).toContain("set by the user");
  });
  it("caps the long edge only", () => {
    expect(screenshotSize(1179, 2556, 1600)).toEqual({ width: 738, height: 1600 });
    expect(screenshotSize(1280, 800, 1600)).toBeUndefined();
  });
});

describe("media emulation", () => {
  it("merges a request into the tab's emulation; system clears a feature", () => {
    const dark = mergeMedia(undefined, { colorScheme: "dark" });
    expect(dark).toEqual({ colorScheme: "dark" });
    expect(mergeMedia(dark, { reducedMotion: "reduce" })).toEqual({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(mergeMedia(dark, { colorScheme: "system" })).toBeUndefined();
  });

  it("sends every feature, an empty value clearing its override", () => {
    expect(mediaFeatures({ colorScheme: "dark" })).toEqual([
      { name: "prefers-color-scheme", value: "dark" },
      { name: "prefers-reduced-motion", value: "" },
    ]);
    expect(mediaFeatures(undefined).every((feature) => feature.value === "")).toBe(true);
  });

  it("describes the emulation for tool results", () => {
    expect(mediaLine({ colorScheme: "light", reducedMotion: "reduce" })).toBe("Emulating: prefers-color-scheme: light, prefers-reduced-motion: reduce");
    expect(mediaLine(undefined)).toBe("");
  });
});

describe("pageToolsText", () => {
  const tool = { name: "add_topping", description: "Add one   or more\ntoppings", inputSchema: '{"type":"object"}', annotations: { destructiveHint: true } };

  it("is empty without tools", () => {
    expect(pageToolsText(null, false)).toBe("");
    expect(pageToolsText([], true)).toBe("");
  });

  it("lists names, hints and flattened descriptions, with schemas on request", () => {
    expect(pageToolsText([tool], false)).toBe("Page tools (WebMCP, provided by the page; call with browser_page_tool):\n- add_topping (destructive): Add one or more toppings");
    expect(pageToolsText([tool], true)).toContain('\n  input: {"type":"object"}');
  });

  it("caps a long list", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ name: `t${i}`, description: "" }));
    expect(pageToolsText(many, false)).toMatch(/\n- t39: \n… and 5 more$/);
  });
});
