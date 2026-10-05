// Where the main window opens: its bounds and zoom from last time (userData/window-state.json) when they still fit
// on a connected display, otherwise the primary display's whole work area. Test instances have their own profile
// (PIGNA_USER_DATA), so they keep their own file and never move the user's window.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { log } from "./log";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** The window's normal (unzoomed) bounds. */
  bounds: Rect;
  maximized: boolean;
}

/** The part of a BrowserWindow this module uses. */
export interface TrackedWindow {
  on(event: "resize" | "move" | "maximize" | "unmaximize" | "close", listener: () => void): unknown;
  getNormalBounds(): Rect;
  isMaximized(): boolean;
}

/** Points of rounding a window edge may stick out of a work area and still count as inside it. */
const SLACK = 8;
/** Moves and resizes come in bursts; save once they settle. */
const SAVE_DELAY = 500;

const isRect = (value: unknown): value is Rect =>
  typeof value === "object" && value !== null && (["x", "y", "width", "height"] as const).every((key) => Number.isFinite((value as Record<string, unknown>)[key]));

export function parseWindowState(raw: unknown): WindowState | undefined {
  const value = raw as { bounds?: unknown; maximized?: unknown } | null;
  if (!value || !isRect(value.bounds) || value.bounds.width <= 0 || value.bounds.height <= 0) return undefined;
  const { x, y, width, height } = value.bounds;
  return { bounds: { x, y, width, height }, maximized: value.maximized === true };
}

/** Whether `bounds` lies inside one of the work areas: a display that was unplugged since no longer holds them. */
export function fitsDisplay(bounds: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some(
    (area) =>
      bounds.x >= area.x - SLACK &&
      bounds.y >= area.y - SLACK &&
      bounds.x + bounds.width <= area.x + area.width + SLACK &&
      bounds.y + bounds.height <= area.y + area.height + SLACK,
  );
}

/** The saved state when it still fits a display; otherwise (first launch too) the primary display's work area. */
export function initialWindowState(saved: WindowState | undefined, workAreas: readonly Rect[], primary: Rect): WindowState {
  if (saved && fitsDisplay(saved.bounds, workAreas)) return saved;
  return { bounds: { ...primary }, maximized: false };
}

export function readWindowState(file: string): WindowState | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("pigna", `could not read ${file}: ${(error as Error).message}`);
    return undefined;
  }
  try {
    return parseWindowState(JSON.parse(raw));
  } catch {
    log.warn("pigna", `${file} is not a window state; opening at the work area`);
    return undefined;
  }
}

/** Save the window's state shortly after it moves, resizes or zooms, and right away when it closes. */
export function trackWindowState(window: TrackedWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(state));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      log.warn("pigna", `could not save ${file}: ${(error as Error).message}`);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"] as const) window.on(event, later);
  window.on("close", save);
}
