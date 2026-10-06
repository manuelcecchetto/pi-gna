import { describe, expect, it } from "vitest";
import { applySettingsOp, emptySettings, parseSettings, SettingsError, settingsConflict, type SettingsOp, TASK_DEFAULTS, taskModel, hidesOnClose, wantsKeepAwake } from "./settings";

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

describe("remote access and host lifecycle", () => {
  const on = applySettingsOp(start, { type: "remoteEnabled", on: true });

  it("is off by default, on port 4517, keeping the Mac awake while it works", () => {
    expect(start.remote).toEqual({ enabled: false, port: 4517, keepAwake: "while-working" });
    expect(start.openAtLogin).toBe(false);
  });

  it("applies each change and returns the same value when nothing changes", () => {
    expect(on.remote.enabled).toBe(true);
    expect(applySettingsOp(on, { type: "remoteEnabled", on: true })).toBe(on);
    expect(applySettingsOp(on, { type: "remotePort", port: 5000 }).remote.port).toBe(5000);
    expect(applySettingsOp(on, { type: "remotePort", port: 4517 })).toBe(on);
    expect(applySettingsOp(on, { type: "keepAwake", mode: "always" }).remote.keepAwake).toBe("always");
    expect(applySettingsOp(on, { type: "keepAwake", mode: "while-working" })).toBe(on);
    expect(applySettingsOp(start, { type: "openAtLogin", on: true }).openAtLogin).toBe(true);
    expect(applySettingsOp(start, { type: "openAtLogin", on: false })).toBe(start);
  });

  it("rejects invalid values", () => {
    for (const port of [80, 70000, 4517.5, "4517", NaN]) expect(() => applySettingsOp(start, { type: "remotePort", port: port as number })).toThrow(SettingsError);
    expect(() => applySettingsOp(start, { type: "keepAwake", mode: "sometimes" as never })).toThrow(SettingsError);
    expect(() => applySettingsOp(start, { type: "remoteEnabled", on: "yes" as never })).toThrow(SettingsError);
    expect(() => applySettingsOp(start, { type: "openAtLogin", on: 1 as never })).toThrow(SettingsError);
  });

  it("keeps Setup's persona once picked", () => {
    expect(start.persona).toBeUndefined();
    const nerd = applySettingsOp(start, { type: "persona", persona: "nerd" });
    expect(nerd.persona).toBe("nerd");
    expect(applySettingsOp(nerd, { type: "persona", persona: "nerd" })).toBe(nerd);
    expect(() => applySettingsOp(start, { type: "persona", persona: "chad" as never })).toThrow(SettingsError);
    expect(parseSettings({ persona: "cool" }).settings.persona).toBe("cool");
    const dropped = parseSettings({ persona: "chad" });
    expect(dropped.dropped).toBe(1);
    expect(dropped.settings.persona).toBeUndefined();
  });

  it("changes behaviour only while remote access is on", () => {
    const always = applySettingsOp(start, { type: "keepAwake", mode: "always" });
    expect(hidesOnClose(start)).toBe(false);
    expect(wantsKeepAwake(always, true)).toBe(false);
    expect(hidesOnClose(on)).toBe(true);
    expect(wantsKeepAwake(on, false)).toBe(false);
    expect(wantsKeepAwake(on, true)).toBe(true);
    expect(wantsKeepAwake(applySettingsOp(on, { type: "keepAwake", mode: "always" }), false)).toBe(true);
    expect(wantsKeepAwake(applySettingsOp(on, { type: "keepAwake", mode: "off" }), true)).toBe(false);
  });

  it("reads the saved values, dropping bad ones", () => {
    const { settings, dropped } = parseSettings({ openAtLogin: true, remote: { enabled: true, port: 80, keepAwake: "always" } });
    expect(settings.remote).toEqual({ enabled: true, port: 4517, keepAwake: "always" });
    expect(settings.openAtLogin).toBe(true);
    expect(dropped).toBe(1);
  });
});
