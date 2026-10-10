import { describe, expect, it } from "vitest";
import type { UpdateRelease } from "../shared/ipc";
import { canDownload, changeError, HOST_ONLY_SECTIONS, MOBILE_SECTIONS, updateSummary } from "./settings-data";

const release: UpdateRelease = { version: "1.2.0", notes: "", url: "https://example.com", publishedAt: "" };

describe("settings sections", () => {
  it("leaves out the keyboard shortcuts, the plugins and the chat import, keeps the rest", () => {
    expect(HOST_ONLY_SECTIONS).toEqual(["shortcuts", "plugins", "import", "about"]);
    expect(new Set(MOBILE_SECTIONS).size).toBe(MOBILE_SECTIONS.length);
  });
});

describe("update line", () => {
  it("says what the update is doing and when Download applies", () => {
    expect(updateSummary({ phase: "idle" })).toMatch(/up to date/);
    expect(updateSummary({ phase: "downloading", release, progress: 0.5 })).toBe("Downloading 1.2.0… 50%");
    expect(updateSummary({ phase: "ready", release })).toMatch(/Restart pi-gna on the Mac/);
    expect(canDownload({ phase: "available", release })).toBe(true);
    expect(canDownload({ phase: "available", release, manual: "read-only" })).toBe(false);
    expect(canDownload({ phase: "downloading", release, progress: 0 })).toBe(false);
    expect(canDownload({ phase: "failed", release, error: "x" })).toBe(true);
  });
});

describe("changeError", () => {
  it("tells a conflict from other errors", () => {
    expect(changeError(new Error("Conflict: theme changed")).conflict).toBe(true);
    expect(changeError(new Error("nope"))).toEqual({ text: "nope", conflict: false });
  });
});
