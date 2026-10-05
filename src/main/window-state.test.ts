import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitsDisplay, initialWindowState, parseWindowState, readWindowState, trackWindowState, type Rect } from "./window-state";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// A 1470×956 laptop (menu bar 33 pt, Dock 69 pt) with a 2560×1440 monitor to its right.
const laptop: Rect = { x: 0, y: 33, width: 1470, height: 854 };
const monitor: Rect = { x: 1470, y: -200, width: 2560, height: 1415 };

describe("fitsDisplay", () => {
  it("accepts bounds inside one work area, edges included", () => {
    expect(fitsDisplay(laptop, [laptop])).toBe(true);
    expect(fitsDisplay({ x: 75, y: 40, width: 1320, height: 800 }, [laptop])).toBe(true);
    expect(fitsDisplay({ x: 1600, y: -100, width: 1320, height: 880 }, [laptop, monitor])).toBe(true);
  });

  it("tolerates a few points of rounding at the edges", () => {
    expect(fitsDisplay({ x: -4, y: 29, width: 1478, height: 862 }, [laptop])).toBe(true);
    expect(fitsDisplay({ x: -20, y: 33, width: 1000, height: 600 }, [laptop])).toBe(false);
  });

  it("refuses bounds on a display that is no longer connected", () => {
    expect(fitsDisplay({ x: 1600, y: -100, width: 1320, height: 880 }, [laptop])).toBe(false);
    expect(fitsDisplay({ x: 0, y: 33, width: 1320, height: 880 }, [])).toBe(false);
  });

  it("refuses bounds larger than the work area or spread over two displays", () => {
    expect(fitsDisplay({ x: 0, y: 33, width: 1470, height: 920 }, [laptop])).toBe(false);
    expect(fitsDisplay({ x: 1000, y: 100, width: 1000, height: 600 }, [laptop, monitor])).toBe(false);
  });
});

describe("initialWindowState", () => {
  it("fills the primary work area on first launch", () => {
    expect(initialWindowState(undefined, [laptop, monitor], laptop)).toEqual({ bounds: laptop, maximized: false });
  });

  it("restores saved bounds and zoom that still fit", () => {
    const saved = { bounds: { x: 1600, y: -100, width: 1320, height: 880 }, maximized: true };
    expect(initialWindowState(saved, [laptop, monitor], laptop)).toBe(saved);
  });

  it("falls back to the primary work area when the saved display is gone", () => {
    const saved = { bounds: { x: 1600, y: -100, width: 1320, height: 880 }, maximized: true };
    expect(initialWindowState(saved, [laptop], laptop)).toEqual({ bounds: laptop, maximized: false });
  });
});

describe("parseWindowState", () => {
  it("keeps valid state and drops anything else", () => {
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 3, height: 4, extra: 5 }, maximized: true })).toEqual({ bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: true });
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: false });
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 0, height: 4 } })).toBeUndefined();
    expect(parseWindowState({ bounds: { x: "1", y: 2, width: 3, height: 4 } })).toBeUndefined();
    expect(parseWindowState(null)).toBeUndefined();
    expect(parseWindowState([])).toBeUndefined();
  });
});

describe("window-state.json", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pigna-window-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads nothing from a missing or broken file", async () => {
    const file = join(dir, "window-state.json");
    expect(readWindowState(file)).toBeUndefined();
    await writeFile(file, "{not json");
    expect(readWindowState(file)).toBeUndefined();
  });

  it("saves once a move settles and right away on close, and reads it back", async () => {
    vi.useFakeTimers();
    const file = join(dir, "window-state.json");
    const listeners = new Map<string, () => void>();
    let bounds: Rect = { x: 10, y: 40, width: 900, height: 700 };
    let maximized = false;
    trackWindowState({ on: (event, listener) => listeners.set(event, listener), getNormalBounds: () => bounds, isMaximized: () => maximized }, file);

    listeners.get("move")?.();
    expect(readWindowState(file)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(readWindowState(file)).toEqual({ bounds, maximized: false });

    bounds = { x: 20, y: 50, width: 1000, height: 760 };
    maximized = true;
    listeners.get("resize")?.();
    listeners.get("close")?.();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ bounds, maximized: true });
  });
});
