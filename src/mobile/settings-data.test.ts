import { describe, expect, it } from "vitest";
import type { UpdateRelease } from "../shared/ipc";
import { USAGE_SOURCES } from "../renderer/src/lib/usage-filters";
import { USAGE_RANGES } from "../shared/usage";
import { canDownload, changeError, HOST_ONLY_SECTIONS, MOBILE_SECTIONS, SECTION_LABELS, updateSummary, USAGE_RANGE_LABELS, USAGE_SOURCE_LABELS, usageProgressText } from "./settings-data";

const release: UpdateRelease = { version: "1.2.0", notes: "", url: "https://example.com", publishedAt: "" };

describe("settings sections", () => {
  it("leaves out the keyboard shortcuts and the plugins, keeps the rest", () => {
    expect(HOST_ONLY_SECTIONS).toEqual(["shortcuts", "plugins", "about"]);
    expect(new Set(MOBILE_SECTIONS).size).toBe(MOBILE_SECTIONS.length);
  });

  it("offers Usage, with a label for every range and source the filters offer", () => {
    expect(MOBILE_SECTIONS).toContain("usage");
    expect(SECTION_LABELS.usage).toBe("Usage");
    expect(Object.keys(USAGE_RANGE_LABELS)).toEqual([...USAGE_RANGES]);
    expect(Object.keys(USAGE_SOURCE_LABELS)).toEqual([...USAGE_SOURCES]);
  });
});

describe("usage progress", () => {
  it("says what the Mac is doing while it reads the session files", () => {
    expect(usageProgressText(undefined)).toBe("Preparing the report…");
    expect(usageProgressText({ phase: "scan", done: 0, total: 0 })).toBe("Listing session files…");
    expect(usageProgressText({ phase: "index", done: 12, total: 85 })).toBe("12 of 85 files");
    expect(usageProgressText({ phase: "done", done: 85, total: 85 })).toBe("Preparing the report…");
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
