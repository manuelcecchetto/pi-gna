import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { debounced, isRunnable, needsReload, previewRoot, relativeTo, reusableTab, watchFile } from "./preview-tabs";

describe("reusableTab", () => {
  it("finds the tab previewing the same path", () => {
    const tabs = [{ id: "a" }, { id: "b", path: "/x/a.pdf" }, { id: "c", path: "/x/b.pdf" }];
    expect(reusableTab(tabs, "/x/b.pdf")).toBe("c");
    expect(reusableTab(tabs, "/x/c.pdf")).toBeUndefined();
  });
});

describe("needsReload", () => {
  it("shows an open preview as it is unless the view, a line or a crash asks for a load", () => {
    expect(needsReload("rendered", "rendered")).toBe(false);
    expect(needsReload("rendered", "rendered", 0)).toBe(false);
    expect(needsReload("rendered", "raw")).toBe(true);
    expect(needsReload("raw", "raw", 12)).toBe(true);
    expect(needsReload("rendered", "rendered", undefined, true)).toBe(true);
  });
});

describe("previewRoot", () => {
  it("prefers the project when the file is inside it", () => {
    expect(previewRoot("/p/src/a.md", "/p")).toBe("/p");
    expect(previewRoot("/q/a.md", "/p")).toBe("/q");
    expect(previewRoot("/pp/a.md", "/p")).toBe("/pp");
    expect(previewRoot("/p/a.md")).toBe("/p");
  });
  it("gives the path below the root", () => expect(relativeTo("/p", "/p/src/a.md")).toBe("src/a.md"));
});

describe("debounced", () => {
  it("collapses bursts and can be cancelled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const call = debounced(fn, 100);
    call();
    call();
    vi.advanceTimersByTime(99);
    call();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    call();
    call.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("watchFile", () => {
  it("fires on edits and on replacement by rename, not on siblings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pigna-watch-"));
    const file = join(dir, "a.md");
    writeFileSync(file, "1");
    const onChange = vi.fn();
    const stop = watchFile(file, onChange, 30);
    try {
      // FSEvents can still report the creation above.
      await new Promise((r) => setTimeout(r, 200));
      onChange.mockClear();
      writeFileSync(join(dir, "other.md"), "x");
      await new Promise((r) => setTimeout(r, 150));
      expect(onChange).not.toHaveBeenCalled();
      writeFileSync(join(dir, "tmp"), "2");
      renameSync(join(dir, "tmp"), file);
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
    } finally {
      stop();
    }
  });
});

describe("isRunnable", () => {
  it("flags programs and executables", () => {
    expect(isRunnable("/x/a.command", 0o644)).toBe(true);
    expect(isRunnable("/x/a.txt", 0o755)).toBe(true);
    expect(isRunnable("/x/a.txt", 0o644)).toBe(false);
  });
});
