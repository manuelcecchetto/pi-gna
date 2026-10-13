import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictationInsert } from "../../../shared/dictation";
import { HOLD_MS, type KeyAction, RightOptionGesture } from "./dictation";

describe("dictationInsert", () => {
  it("separates the transcript from the words around it", () => {
    expect(dictationInsert("", " Hello there. ", "")).toBe("Hello there.");
    expect(dictationInsert("Fix", "the test", "")).toBe(" the test");
    expect(dictationInsert("Fix ", "the test", "")).toBe("the test");
    expect(dictationInsert("Fix ", "the test", "now")).toBe("the test ");
    expect(dictationInsert("Fix ", "the test", ".")).toBe("the test");
    expect(dictationInsert("Fix", "  ", "now")).toBe("");
  });
});

describe("RightOptionGesture", () => {
  let actions: KeyAction[];
  let recording: boolean;
  let gesture: RightOptionGesture;
  const down = (code = "AltRight", repeat = false) => gesture.keydown({ code, repeat });
  const up = (code = "AltRight") => gesture.keyup({ code });

  beforeEach(() => {
    vi.useFakeTimers();
    actions = [];
    recording = false;
    gesture = new RightOptionGesture(
      (action) => {
        actions.push(action);
        if (action === "start") recording = true;
        else recording = false;
      },
      () => recording,
    );
  });
  afterEach(() => vi.useRealTimers());

  it("starts on a tap and stops on the next one", () => {
    down();
    up();
    expect(actions).toEqual(["start"]);
    vi.advanceTimersByTime(5000);
    down();
    vi.advanceTimersByTime(HOLD_MS * 2);
    up();
    expect(actions).toEqual(["start", "stop"]);
  });

  it("records while held and stops when let go", () => {
    down();
    for (let i = 0; i < 5; i++) down("AltRight", true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(actions).toEqual(["start"]);
    vi.advanceTimersByTime(3000);
    up();
    expect(actions).toEqual(["start", "stop"]);
  });

  it("stays out of the way when Option is a modifier", () => {
    // ⌥e, typed quickly: neither a tap nor a hold.
    down();
    down("KeyE");
    up();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(actions).toEqual([]);
    // Held, then another key: the recording it started is dropped.
    down();
    vi.advanceTimersByTime(HOLD_MS);
    down("ArrowLeft");
    up();
    expect(actions).toEqual(["start", "cancel"]);
    // The left Option key never dictates.
    down("AltLeft");
    up("AltLeft");
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(actions).toEqual(["start", "cancel"]);
  });

  it("stops a held recording when the window loses focus", () => {
    down();
    vi.advanceTimersByTime(HOLD_MS);
    gesture.blur();
    up();
    expect(actions).toEqual(["start", "stop"]);
  });

  it("stops a recording the mic button started", () => {
    recording = true;
    down();
    vi.advanceTimersByTime(HOLD_MS * 2);
    up();
    expect(actions).toEqual(["stop"]);
  });
});
