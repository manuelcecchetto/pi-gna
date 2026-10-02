import { describe, expect, it } from "vitest";
import { isLocalUrl, normalizeAddress } from "./browser";

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
