import { describe, expect, it } from "vitest";
import type { BrowserTab } from "../shared/browser";
import { agentActive, classify, isWindowTab, pageSize, RESPONSIVE_SIZE, suggestions, tabTitle, toPagePoint, viewportLabel, wheelDelta } from "./browser-data";

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({ id: "t1", url: "http://localhost:5173/app", title: "", loading: false, canGoBack: false, canGoForward: false, ...patch });
const viewport = { width: 393, height: 852, dpr: 3, mobile: true, touch: true, userAgent: "iphone" as const, label: "iPhone 15", source: "user" as const };

describe("toPagePoint", () => {
  const page = { width: 393, height: 852 };
  it("maps a touch on the frame to CSS px of the page", () => {
    expect(toPagePoint({ x: 100 + 98.25, y: 50 + 213 }, { left: 100, top: 50, width: 196.5, height: 426 }, page)).toEqual({ x: 197, y: 426 });
  });
  it("follows a zoomed (larger, shifted) frame box", () => {
    expect(toPagePoint({ x: 0, y: 0 }, { left: -393, top: 0, width: 786, height: 1704 }, page)).toEqual({ x: 197, y: 0 });
  });
  it("clamps inside the page", () => {
    expect(toPagePoint({ x: -50, y: 9999 }, { left: 0, top: 0, width: 100, height: 200 }, page)).toEqual({ x: 0, y: 851 });
  });
});

describe("wheelDelta", () => {
  it("moves the page with the finger, in page px", () => {
    expect(wheelDelta({ dx: 0, dy: -50 }, { left: 0, top: 0, width: 196.5, height: 426 }, { width: 393, height: 852 })).toEqual({ dx: 0, dy: 100 });
  });
});

describe("tabs", () => {
  it("falls back to the host for a title, and to the responsive size for a viewport", () => {
    expect(tabTitle(tab())).toBe("localhost:5173");
    expect(tabTitle(tab({ title: " App " }))).toBe("App");
    expect(pageSize(tab())).toEqual(RESPONSIVE_SIZE);
    expect(pageSize(tab({ viewport }))).toEqual({ width: 393, height: 852 });
    expect(viewportLabel(tab({ viewport }))).toBe("iPhone 15");
    expect(viewportLabel(tab())).toBe("Responsive");
  });
  it("marks windows and a recently driven tab", () => {
    expect(isWindowTab(tab({ surface: "window" }))).toBe(true);
    expect(agentActive(tab({ agentAt: 1000 }), 5000)).toBe(true);
    expect(agentActive(tab({ agentAt: 1000 }), 20000)).toBe(false);
    expect(agentActive(tab(), 5000)).toBe(false);
  });
});

describe("suggestions", () => {
  const history = [
    { url: "http://localhost:3000/", title: "Home", at: 1 },
    { url: "http://localhost:3000/", title: "Home", at: 5 },
    { url: "https://example.com/docs", title: "Docs", at: 3 },
  ];
  it("matches every word, newest first, one row per URL", () => {
    expect(suggestions(history, "local").map((e) => e.at)).toEqual([5]);
    expect(suggestions(history, "docs exam")).toHaveLength(1);
    expect(suggestions(history, "o").map((e) => e.at)).toEqual([5, 3]);
    expect(suggestions(history, "  ")).toEqual([]);
  });
});

describe("classify", () => {
  it("tells a tap, a long press and a drag apart", () => {
    expect(classify(3, 120)).toBe("tap");
    expect(classify(3, 700)).toBe("longPress");
    expect(classify(40, 100)).toBe("drag");
  });
});
