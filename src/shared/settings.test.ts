import { describe, expect, it } from "vitest";
import { applySettingsOp, emptySettings, parseSettings, SettingsError, settingsConflict, type SettingsOp, TASK_DEFAULTS, taskModel } from "./settings";

const start = emptySettings();

describe("applySettingsOp", () => {
  it("has every feature on and follows the system's appearance by default", () => {
    expect(start.features).toEqual({ kanban: true, laments: true, github: true, atp: true });
    expect(start.theme).toBe("system");
    expect(start.wallpaper).toBe("sky");
    expect(start.wallpaperLoop).toBe(false);
    expect(start.visuals).toBe(false);
    expect(taskModel(start, "triage")).toBe(TASK_DEFAULTS.triage);
  });

  it("turns features off and on, and changes nothing twice", () => {
    const off = applySettingsOp(start, { type: "feature", feature: "atp", enabled: false });
    expect(off.features.atp).toBe(false);
    expect(off.features.kanban).toBe(true);
    expect(applySettingsOp(off, { type: "feature", feature: "atp", enabled: false })).toBe(off);
    expect(applySettingsOp(off, { type: "feature", feature: "atp", enabled: true }).features.atp).toBe(true);
    expect(applySettingsOp(start, { type: "theme", theme: "system" })).toBe(start);
    expect(applySettingsOp(start, { type: "theme", theme: "dark" }).theme).toBe("dark");
    expect(applySettingsOp(start, { type: "wallpaper", wallpaper: "sky" })).toBe(start);
    expect(applySettingsOp(start, { type: "wallpaper", wallpaper: "fresco" }).wallpaper).toBe("fresco");
    expect(applySettingsOp(start, { type: "wallpaper", wallpaper: "none" }).wallpaper).toBe("none");
    expect(applySettingsOp(start, { type: "wallpaperLoop", loop: false })).toBe(start);
    expect(applySettingsOp(start, { type: "wallpaperLoop", loop: true }).wallpaperLoop).toBe(true);
    expect(applySettingsOp(start, { type: "visuals", on: false })).toBe(start);
    expect(applySettingsOp(start, { type: "visuals", on: true }).visuals).toBe(true);
  });

  it("overrides a task's model and goes back to the default", () => {
    const worker = { provider: "anthropic", id: "claude-opus-5-5", thinking: "high" } as const;
    const set = applySettingsOp(start, { type: "model", task: "worker", model: { ...worker } });
    expect(taskModel(set, "worker")).toEqual(worker);
    expect(applySettingsOp(set, { type: "model", task: "worker", model: { ...worker } })).toBe(set);
    const back = applySettingsOp(set, { type: "model", task: "worker", model: null });
    expect(back.models).toEqual({});
    expect(taskModel(back, "worker")).toBe(TASK_DEFAULTS.worker);
    expect(applySettingsOp(start, { type: "model", task: "worker", model: null })).toBe(start);
  });

  it("refuses what it does not know", () => {
    const bad = [
      { type: "feature", feature: "computer", enabled: false },
      { type: "feature", feature: "atp", enabled: "no" },
      { type: "theme", theme: "sepia" },
      { type: "wallpaper", wallpaper: "pigna-dusk" },
      { type: "wallpaperLoop", loop: "yes" },
      { type: "visuals", on: "yes" },
      { type: "model", task: "review", model: null },
      { type: "model", task: "triage", model: { id: "", thinking: "low" } },
      { type: "model", task: "triage", model: { id: "m", thinking: "lots" } },
      { type: "model", task: "triage", model: { provider: 3, id: "m", thinking: "low" } },
      { type: "reset" },
    ];
    for (const op of bad) expect(() => applySettingsOp(start, op as unknown as SettingsOp)).toThrow(SettingsError);
  });
});

describe("parseSettings", () => {
  it("reads what it knows and falls back for the rest", () => {
    const { settings, dropped } = parseSettings({
      version: 1,
      features: { kanban: false, github: "off", future: true },
      theme: "sepia",
      wallpaper: "moon",
      wallpaperLoop: 1,
      visuals: "on",
      models: { triage: { id: "claude-haiku-4-5", thinking: "off" }, worker: { id: "x" }, other: {} },
    });
    expect(settings.features).toEqual({ kanban: false, laments: true, github: true, atp: true });
    expect(settings.theme).toBe("system");
    expect(settings.wallpaper).toBe("sky");
    expect(parseSettings({ wallpaper: "ink" }).settings.wallpaper).toBe("ink");
    expect(parseSettings({ wallpaperLoop: true }).settings.wallpaperLoop).toBe(true);
    expect(parseSettings({ visuals: true }).settings.visuals).toBe(true);
    expect(settings.models).toEqual({ triage: { id: "claude-haiku-4-5", thinking: "off" } });
    expect(dropped).toBe(6);
    expect(parseSettings({}).settings).toEqual(start);
  });

  it("throws for what is no settings file", () => {
    expect(() => parseSettings([])).toThrow(SettingsError);
    expect(() => parseSettings(null)).toThrow(SettingsError);
  });
});

describe("settingsConflict", () => {
  const dark = { ...emptySettings(), theme: "dark" as const };
  it("flags a theme, wallpaper or task model changed since the base, not switches", () => {
    expect(settingsConflict(emptySettings(), dark, { type: "theme", theme: "light" })).toBe(true);
    expect(settingsConflict(emptySettings(), dark, { type: "wallpaper", wallpaper: "ink" })).toBe(false);
    expect(settingsConflict(emptySettings(), dark, { type: "model", task: "triage", model: null })).toBe(false);
    expect(settingsConflict(emptySettings(), { ...dark, models: { triage: { id: "m", thinking: "low" } } }, { type: "model", task: "triage", model: null })).toBe(true);
    expect(settingsConflict(emptySettings(), dark, { type: "visuals", on: true })).toBe(false);
    expect(settingsConflict(undefined, dark, { type: "theme", theme: "light" })).toBe(true);
  });
});
