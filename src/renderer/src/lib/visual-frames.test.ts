import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_EVENT } from "./theme";

type Mod = typeof import("./visual-frames");

/** A frame's window as the shared listener sees it: only its identity matters. */
const frameWindow = () => ({}) as MessageEventSource;

describe("linkFrame", () => {
  let mod: Mod;
  let win: EventTarget & { matchMedia(query: string): MediaQueryList };
  let media: EventTarget;
  let listening: Map<string, number>;
  let styleReads: number;
  const fire = (source: MessageEventSource | null, data: unknown) => win.dispatchEvent(Object.assign(new Event("message"), { source, data }));
  const handlers = () => ({ onMessage: vi.fn(), onHung: vi.fn(), post: vi.fn() });

  beforeEach(async () => {
    vi.useFakeTimers();
    media = new EventTarget();
    listening = new Map();
    const target = new EventTarget();
    const count = (on: EventTarget, prefix: string) => {
      const add = on.addEventListener.bind(on);
      const remove = on.removeEventListener.bind(on);
      on.addEventListener = (type: string, ...rest: unknown[]) => {
        listening.set(prefix + type, (listening.get(prefix + type) ?? 0) + 1);
        add(type, ...(rest as [EventListener]));
      };
      on.removeEventListener = (type: string, ...rest: unknown[]) => {
        listening.set(prefix + type, (listening.get(prefix + type) ?? 0) - 1);
        remove(type, ...(rest as [EventListener]));
      };
    };
    count(target, "");
    count(media, "media:");
    win = Object.assign(target, { matchMedia: () => media as MediaQueryList });
    styleReads = 0;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => {
      styleReads++;
      return { getPropertyValue: (name: string) => (name === "--fg" ? " #111 " : name === "--c1" ? " #c1 " : "") };
    });
    vi.resetModules();
    mod = await import("./visual-frames");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("installs one listener of each kind for every frame, and removes them with the last", () => {
    const a = mod.linkFrame(frameWindow(), handlers());
    const b = mod.linkFrame(frameWindow(), handlers());
    expect(Object.fromEntries(listening)).toEqual({ message: 1, [THEME_EVENT]: 1, "media:change": 1 });
    expect(vi.getTimerCount()).toBe(1);
    a.unlink();
    a.unlink(); // twice is harmless
    expect(Object.fromEntries(listening)).toEqual({ message: 1, [THEME_EVENT]: 1, "media:change": 1 });
    b.unlink();
    expect(Object.fromEntries(listening)).toEqual({ message: 0, [THEME_EVENT]: 0, "media:change": 0 });
    expect(vi.getTimerCount()).toBe(0);
    mod.linkFrame(frameWindow(), handlers());
    expect(Object.fromEntries(listening)).toEqual({ message: 1, [THEME_EVENT]: 1, "media:change": 1 });
  });

  it("routes each frame's messages to its own handlers, objects only", () => {
    const one = frameWindow();
    const two = frameWindow();
    const first = handlers();
    const second = handlers();
    mod.linkFrame(one, first);
    mod.linkFrame(two, second);
    fire(two, { type: "height", px: 90 });
    fire(one, "not an object");
    fire(one, null);
    fire(frameWindow(), { type: "ready" });
    fire(null, { type: "ready" });
    expect(first.onMessage).not.toHaveBeenCalled();
    expect(second.onMessage).toHaveBeenCalledExactlyOnceWith({ type: "height", px: 90 });
  });

  it("flags a frame that sent nothing for more than 8 s, once", () => {
    const view = frameWindow();
    const link = handlers();
    mod.linkFrame(view, link);
    vi.advanceTimersByTime(mod.WATCHDOG_MS);
    expect(link.onHung).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(link.onHung).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20_000);
    expect(link.onHung).toHaveBeenCalledOnce();
  });

  it("any message, or a beat, keeps a frame alive; a bad one does not", () => {
    const view = frameWindow();
    const link = handlers();
    const linked = mod.linkFrame(view, link);
    vi.advanceTimersByTime(6000);
    fire(view, { type: "heartbeat" });
    vi.advanceTimersByTime(6000);
    expect(link.onHung).not.toHaveBeenCalled();
    linked.beat();
    vi.advanceTimersByTime(6000);
    fire(view, "junk");
    vi.advanceTimersByTime(2000);
    expect(link.onHung).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(link.onHung).toHaveBeenCalledOnce();
  });

  it("linking a window again replaces its link, and the old unlink leaves the new one", () => {
    const view = frameWindow();
    const old = handlers();
    const young = handlers();
    const first = mod.linkFrame(view, old);
    mod.linkFrame(view, young);
    first.unlink();
    fire(view, { type: "ready" });
    expect(old.onMessage).not.toHaveBeenCalled();
    expect(young.onMessage).toHaveBeenCalledOnce();
    expect(listening.get("message")).toBe(1);
  });

  it("watches each frame on its own clock", () => {
    const old = handlers();
    mod.linkFrame(frameWindow(), old);
    vi.advanceTimersByTime(5000);
    const young = handlers();
    mod.linkFrame(frameWindow(), young);
    vi.advanceTimersByTime(4000);
    expect(old.onHung).toHaveBeenCalledOnce();
    expect(young.onHung).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(young.onHung).toHaveBeenCalledOnce();
  });

  it("an unlinked frame is neither routed nor watched", () => {
    const view = frameWindow();
    const link = handlers();
    mod.linkFrame(frameWindow(), handlers()); // keeps the listeners installed
    mod.linkFrame(view, link).unlink();
    fire(view, { type: "ready" });
    vi.advanceTimersByTime(20_000);
    expect(link.onMessage).not.toHaveBeenCalled();
    expect(link.onHung).not.toHaveBeenCalled();
  });

  it("posts the new tokens to every frame on a theme change, reading them once", () => {
    const a = handlers();
    const b = handlers();
    mod.linkFrame(frameWindow(), a);
    mod.linkFrame(frameWindow(), b);
    win.dispatchEvent(new Event(THEME_EVENT));
    media.dispatchEvent(new Event("change"));
    expect(styleReads).toBe(2);
    const tokens = { "--fg": "#111", "--c1": "#c1", "--c2": "", "--c3": "" };
    expect(a.post.mock.calls).toEqual([[{ type: "tokens", tokens }], [{ type: "tokens", tokens }]]);
    expect(b.post.mock.calls).toEqual(a.post.mock.calls);
  });
});
