// Pure helpers of the phone's browser screen: where a touch lands on the page, which tabs mean what, address suggestions.
import { AGENT_ACTIVE_MS, type BrowserTab, type HistoryEntry } from "../shared/browser";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}

/** What a tab without an emulated viewport is streamed at: the host parks it at this size (docs/REMOTE.md section 4). */
export const RESPONSIVE_SIZE: Size = { width: 1280, height: 800 };

/** The page size input coordinates are in. */
export const pageSize = (tab: BrowserTab): Size => (tab.viewport ? { width: tab.viewport.width, height: tab.viewport.height } : RESPONSIVE_SIZE);

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A touch point (client px) on the drawn frame (its box on screen, zoom included) -> CSS px of the page, clamped inside it. */
export function toPagePoint(touch: { x: number; y: number }, frame: Box, page: Size): { x: number; y: number } {
  const x = ((touch.x - frame.left) / Math.max(1, frame.width)) * page.width;
  const y = ((touch.y - frame.top) / Math.max(1, frame.height)) * page.height;
  return { x: clamp(Math.round(x), 0, page.width - 1), y: clamp(Math.round(y), 0, page.height - 1) };
}

/** A finger dragged by (dx, dy) px: the wheel delta in CSS px that moves the page with it (content follows the finger). */
export function wheelDelta(drag: { dx: number; dy: number }, frame: Box, page: Size): { dx: number; dy: number } {
  const scale = page.width / Math.max(1, frame.width);
  return { dx: Math.round(-drag.dx * scale) || 0, dy: Math.round(-drag.dy * scale) || 0 };
}

export const AGENT_BADGE = "agent";
/** The agent drove this tab within the last few seconds. */
export const agentActive = (tab: BrowserTab, now: number) => tab.agentAt !== undefined && now - tab.agentAt < AGENT_ACTIVE_MS;

/** A pop-out device window lives on the Mac: the phone can view and drive it, not move it. */
export const isWindowTab = (tab: BrowserTab) => tab.surface === "window";

export function tabTitle(tab: BrowserTab): string {
  if (tab.preview) return tab.preview.name;
  if (tab.title.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "New tab";
  }
}

/** What the address bar shows: a preview's file path (the tab URL carries a pigna-file token), else the URL. */
export const tabAddress = (tab: BrowserTab) => tab.preview?.path ?? tab.url;

export const viewportLabel = (tab: BrowserTab) => tab.viewport?.label ?? "Responsive";

/** History entries for what was typed: URL or title contains every word, most recent first; one row per URL. */
export function suggestions(history: HistoryEntry[], query: string, limit = 6): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const entry of [...history].sort((a, b) => b.at - a.at)) {
    const haystack = `${entry.url} ${entry.title}`.toLowerCase();
    if (seen.has(entry.url) || !words.every((word) => haystack.includes(word))) continue;
    seen.add(entry.url);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** The keys the phone's keyboard cannot type; `key` is what `browser.input` takes. */
export const KEYS = [
  { key: "Enter", label: "Enter" },
  { key: "Tab", label: "Tab" },
  { key: "Escape", label: "Esc" },
  { key: "Backspace", label: "⌫" },
  { key: "ArrowUp", label: "↑" },
  { key: "ArrowDown", label: "↓" },
  { key: "ArrowLeft", label: "←" },
  { key: "ArrowRight", label: "→" },
] as const;

/** One finger on the frame: a tap, a long press, or a drag, from where it started and how long it stayed. */
export type Gesture = "tap" | "longPress" | "drag";
export const TAP_SLOP_PX = 10;
export const LONG_PRESS_MS = 500;
export function classify(moved: number, heldMs: number): Gesture {
  if (moved > TAP_SLOP_PX) return "drag";
  return heldMs >= LONG_PRESS_MS ? "longPress" : "tap";
}
