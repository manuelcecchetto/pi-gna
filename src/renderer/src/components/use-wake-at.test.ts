import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ wakeUp: vi.fn(), effects: [] as { run: () => (() => void) | void; deps: unknown[] }[] }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useReducer: () => [7, hooks.wakeUp],
  useEffect: (run: () => (() => void) | void, deps: unknown[]) => void hooks.effects.push({ run, deps }),
}));
const { useWakeAt } = await import("./primitives");

describe("useWakeAt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
    hooks.effects.length = 0;
    hooks.wakeUp.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("re-renders once at the given time, re-arming after each wake", () => {
    useWakeAt(12_000);
    const [effect] = hooks.effects;
    expect(effect!.deps).toEqual([12_000, 7]);
    const cleanup = effect!.run();
    vi.advanceTimersByTime(1999);
    expect(hooks.wakeUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hooks.wakeUp).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    effect!.run();
    (cleanup as () => void)();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does nothing without a time, and cancels on cleanup", () => {
    useWakeAt(undefined);
    expect(hooks.effects[0]!.run()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    useWakeAt(11_000);
    const cleanup = hooks.effects[1]!.run() as () => void;
    cleanup();
    vi.advanceTimersByTime(5000);
    expect(hooks.wakeUp).not.toHaveBeenCalled();
  });
});
