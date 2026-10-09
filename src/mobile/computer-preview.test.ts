import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../shared/session-state";
import { keepFrame, PREVIEW_POLL_MS, type PreviewPage, pollPreview, runUsesComputer } from "./computer-preview";

const user = (steer?: boolean): Item => ({ kind: "user", key: "u", message: { role: "user", content: "go", timestamp: 0 }, steer }) as Item;
const calls = (...names: string[]): Item =>
  ({ kind: "assistant", key: "a", streaming: false, message: { role: "assistant", content: names.map((name, i) => ({ type: "toolCall", id: `t${i}`, name, arguments: {} })) } }) as unknown as Item;

describe("runUsesComputer", () => {
  it("is true once the current run calls a computer_* tool, steers included", () => {
    expect(runUsesComputer([user(), calls("read")])).toBe(false);
    expect(runUsesComputer([user(), calls("computer_get_app_state"), user(true), calls("read")])).toBe(true);
    expect(runUsesComputer([user(), calls("read", "computer_click")])).toBe(true);
  });
  it("ignores earlier runs and listing apps, which holds none", () => {
    expect(runUsesComputer([user(), calls("computer_click"), user(), calls("read")])).toBe(false);
    expect(runUsesComputer([user(), calls("computer_list_apps")])).toBe(false);
    expect(runUsesComputer([])).toBe(false);
  });
  it("counts a page that starts inside the run as maybe", () => {
    expect(runUsesComputer([calls("read")])).toBe(true);
    expect(runUsesComputer([user(true), calls("read")])).toBe(true);
  });
});

describe("keepFrame", () => {
  const full = { id: "f1", app: "Notes", mimeType: "image/jpeg", data: "AAAA" };
  it("takes a new frame and keeps the shown one while it is unchanged", () => {
    expect(keepFrame(null, full)).toBe(full);
    expect(keepFrame(full, { id: "f1", app: "Notes" })).toBe(full);
    expect(keepFrame(full, { id: "f1", app: "Notes 2" })).toEqual({ ...full, app: "Notes 2" });
  });
  it("shows nothing for null or an id it does not have", () => {
    expect(keepFrame(full, null)).toBeNull();
    expect(keepFrame(full, { id: "f2", app: "Notes" })).toBeNull();
    expect(keepFrame(null, { id: "f1", app: "Notes" })).toBeNull();
  });
});

describe("pollPreview", () => {
  let hidden = false;
  let listener = () => {};
  const page: PreviewPage = { hidden: () => hidden, onVisibility: (l) => ((listener = l), () => (listener = () => {})) };
  const setHidden = (value: boolean) => ((hidden = value), listener());
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
  });
  afterEach(() => vi.useRealTimers());

  it("never overlaps calls and waits for each answer", async () => {
    let resolve = (_: string) => {};
    const fetch = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const frames: string[] = [];
    const stop = pollPreview(fetch, (f) => frames.push(f), page);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 5);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve("a");
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(frames).toEqual(["a"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("makes no calls while hidden and asks right away when shown", async () => {
    const fetch = vi.fn(async () => "f");
    const stop = pollPreview(fetch, () => {}, page);
    await vi.advanceTimersByTimeAsync(0);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 10);
    expect(fetch).toHaveBeenCalledTimes(1);
    setHidden(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 10);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stays one call at a time across hide and show, and asks at once when shown after the answer", async () => {
    let resolve = (_: string) => {};
    const fetch = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const stop = pollPreview(fetch, () => {}, page);
    setHidden(true);
    setHidden(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    setHidden(true);
    resolve("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    setHidden(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("leaves no timer while hidden and none after stop, and drops an answer that comes after it", async () => {
    let resolve = (_: string) => {};
    const fetch = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const frames: string[] = [];
    const stop = pollPreview(fetch, (f) => frames.push(f), page);
    resolve("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    setHidden(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
    resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 3);
    expect(frames).toEqual(["a"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not start while hidden, and a rejected call keeps polling", async () => {
    hidden = true;
    const fetch = vi.fn(async () => Promise.reject(new Error("rate_limited")));
    const stop = pollPreview(fetch, () => {}, page);
    expect(fetch).not.toHaveBeenCalled();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });
});
